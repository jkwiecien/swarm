/**
 * GitHub webhook receiver — the router'\''s HTTP surface, modeled on Cascade'\''s
 * `src/router/index.ts` route wiring but trimmed to SWARM'\''s single SCM.
 *
 * `POST /github/webhook` is the whole pipeline up to the queue: read the raw
 * body, authenticate it (HMAC), match it to a SWARM project, drop SWARM'\''s own
 * comment events (loop prevention), then hand the normalized event to the
 * enqueue seam. Everything downstream of the seam — trigger routing, the worker
 * — is a later phase (see `enqueue.ts`).
 *
 * The app is built by a factory taking its collaborators as parameters so tests
 * can drive it via `app.request()` with fakes, without a live server, DB, or
 * real credentials — the same reason Cascade extracts its verifier/handler
 * logic out of the side-effect-heavy entry point.
 */

import { Hono } from 'hono';

import { findProjectByRepo, getWebhookSecretOrNull } from '../config/provider.js';
import type { ProjectConfig } from '../config/schema.js';
import { logger } from '../lib/logger.js';
import { verifyGitHubSignature } from '../webhook/signature-verification.js';
import { GitHubRouterAdapter } from './adapters/github.js';
import { enqueueWebhookEvent } from './enqueue.js';

/** Header GitHub delivers the event type in (not carried in the body). */
const EVENT_TYPE_HEADER = 'x-github-event';
/** Header carrying the HMAC-SHA256 signature GitHub signs the raw body with. */
const SIGNATURE_HEADER = 'x-hub-signature-256';
/** Per-delivery id GitHub sends; carried through for idempotency/tracing. */
const DELIVERY_HEADER = 'x-github-delivery';

/**
 * Collaborators the receiver depends on. Defaulted to the real implementations
 * so production wiring is a bare `createWebhookApp()`; tests inject fakes.
 */
export interface WebhookReceiverDeps {
	adapter: GitHubRouterAdapter;
	findProject: (repo: string) => Promise<ProjectConfig | undefined>;
	getWebhookSecret: (project: ProjectConfig) => Promise<string | null>;
	enqueue: (
		event: import('./adapters/github.js').GitHubParsedEvent,
		project: ProjectConfig,
		deliveryId: string | undefined,
	) => Promise<void>;
	verifySignature: (rawBody: string, signature: string, secret: string) => boolean;
}

function defaultDeps(): WebhookReceiverDeps {
	return {
		adapter: new GitHubRouterAdapter(),
		findProject: findProjectByRepo,
		getWebhookSecret: getWebhookSecretOrNull,
		enqueue: enqueueWebhookEvent,
		verifySignature: verifyGitHubSignature,
	};
}

/**
 * Build the router'\''s Hono app. Pass `overrides` to substitute collaborators in
 * tests; omit for the production wiring.
 */
export function createWebhookApp(overrides: Partial<WebhookReceiverDeps> = {}): Hono {
	const deps = { ...defaultDeps(), ...overrides };
	const app = new Hono();

	// Liveness probe for the Docker Compose healthcheck.
	app.get('/health', (c) => c.json({ status: 'ok', service: 'router' }));

	// GitHub pings the endpoint with a GET when a webhook is (re)configured.
	app.get('/github/webhook', (c) => c.text('OK', 200));

	app.post('/github/webhook', async (c) => {
		// The signature covers the exact bytes GitHub sent — read the raw body and
		// never re-serialize it, or the HMAC will not match.
		const rawBody = await c.req.text();
		const eventType = c.req.header(EVENT_TYPE_HEADER) ?? 'unknown';
		const deliveryId = c.req.header(DELIVERY_HEADER);

		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return c.json({ ok: false, reason: 'invalid JSON body' }, 400);
		}

		// Non-actionable event type → acknowledge so GitHub stops retrying, but do
		// no work. `parseWebhook` returns null for anything outside PROCESSABLE_EVENTS.
		const event = deps.adapter.parseWebhook(eventType, payload);
		if (!event) {
			return c.json({ ok: true, ignored: true, reason: `unhandled event type: ${eventType}` }, 202);
		}

		// Untracked repo → not ours. Ack without work (and before touching secrets).
		const project = await deps.findProject(event.repoFullName);
		if (!project) {
			return c.json({ ok: true, ignored: true, reason: 'repo not tracked by any project' }, 202);
		}

		// Authenticate before acting. A project with no secret configured cannot be
		// verified, so we refuse rather than trusting an unauthenticated payload.
		const secret = await deps.getWebhookSecret(project);
		if (!secret) {
			logger.error('No webhook secret configured for project; rejecting webhook', {
				projectId: project.id,
				repo: event.repoFullName,
			});
			return c.json({ ok: false, reason: 'webhook secret not configured' }, 401);
		}

		const signature = c.req.header(SIGNATURE_HEADER) ?? '';
		if (!deps.verifySignature(rawBody, signature, secret)) {
			logger.warn('GitHub webhook signature verification failed', {
				projectId: project.id,
				repo: event.repoFullName,
				eventType: event.eventType,
			});
			return c.json({ ok: false, reason: 'signature verification failed' }, 401);
		}

		// Loop prevention: drop SWARM'\''s own comment events so a persona never
		// reacts to its own ack/reply. PR/review lifecycle events flow through even
		// when a persona produced them (the *other* persona must act) — that
		// cross-persona routing is the adapter'\''s job, not this gate'\''s.
		if (await deps.adapter.isSelfAuthored(event, project)) {
			return c.json(
				{ ok: true, ignored: true, reason: 'self-authored comment (loop prevention)' },
				202,
			);
		}

		await deps.enqueue(event, project, deliveryId);
		return c.json({ ok: true, accepted: true }, 202);
	});

	return app;
}
