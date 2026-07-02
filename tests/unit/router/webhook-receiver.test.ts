import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '@/config/schema.js';
import { logger } from '@/lib/logger.js';
import type { GitHubParsedEvent, GitHubRouterAdapter } from '@/router/adapters/github.js';
import type {
	GitHubProjectsParsedEvent,
	GitHubProjectsRouterAdapter,
} from '@/router/adapters/github-projects.js';
import { createWebhookApp, type WebhookReceiverDeps } from '@/router/webhook-receiver.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const project = createMockProjectConfig({ id: 'proj-1', repo: 'jkwiecien/swarm' });

const prEvent: GitHubParsedEvent = {
	eventType: 'pull_request',
	action: 'opened',
	repoFullName: 'jkwiecien/swarm',
	workItemId: '1',
	actorLogin: 'human-dev',
	isCommentEvent: false,
};

/**
 * Build an app with fully-faked collaborators. Defaults describe the happy path
 * (event parses, repo is tracked, secret exists, signature valid, not
 * self-authored); each test overrides only the stage it exercises.
 */
function makeApp(overrides: Partial<WebhookReceiverDeps> = {}) {
	const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);
	const adapter = {
		parseWebhook: vi.fn().mockReturnValue(prEvent),
		isSelfAuthored: vi.fn().mockResolvedValue(false),
	} as unknown as GitHubRouterAdapter;

	const deps: Partial<WebhookReceiverDeps> = {
		adapter,
		findProject: vi
			.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
			.mockResolvedValue(project),
		getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue('whsec'),
		verifySignature: vi.fn<WebhookReceiverDeps['verifySignature']>().mockReturnValue(true),
		enqueue,
		...overrides,
	};

	return { app: createWebhookApp(deps), deps, enqueue, adapter };
}

/** Fire a POST at the webhook endpoint with sensible default headers. */
function post(
	app: ReturnType<typeof makeApp>['app'],
	body: string,
	headers: Record<string, string> = {},
) {
	return app.request('/github/webhook', {
		method: 'POST',
		headers: {
			'x-github-event': 'pull_request',
			'x-hub-signature-256': 'sha256=abc',
			'x-github-delivery': 'delivery-1',
			'content-type': 'application/json',
			...headers,
		},
		body,
	});
}

const VALID_BODY = JSON.stringify({ action: 'opened', number: 1 });

describe('createWebhookApp', () => {
	beforeEach(() => vi.clearAllMocks());

	describe('GET routes', () => {
		it('serves a health probe', async () => {
			const { app } = makeApp();
			const res = await app.request('/health');
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: 'ok', service: 'router' });
		});

		it('answers the GitHub GET ping on the webhook path', async () => {
			const { app } = makeApp();
			const res = await app.request('/github/webhook');
			expect(res.status).toBe(200);
		});
	});

	describe('POST /github/webhook', () => {
		it('accepts and enqueues a valid, verified, human-authored event', async () => {
			const { app, enqueue } = makeApp();
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ ok: true, accepted: true });
			expect(enqueue).toHaveBeenCalledWith(prEvent, project, 'delivery-1');
		});

		it('rejects a malformed JSON body with 400', async () => {
			const { app, enqueue } = makeApp();
			const res = await post(app, 'not json{');
			expect(res.status).toBe(400);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('acknowledges but ignores an unhandled event type', async () => {
			const adapter = {
				parseWebhook: vi.fn().mockReturnValue(null),
				isSelfAuthored: vi.fn(),
			} as unknown as GitHubRouterAdapter;
			const { app, enqueue } = makeApp({ adapter });
			const res = await post(app, VALID_BODY, { 'x-github-event': 'star' });
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('acknowledges but ignores an event for an untracked repo', async () => {
			const { app, enqueue, deps } = makeApp({
				findProject: vi
					.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(undefined),
			});
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			// Must not touch secrets or the queue for a repo that isn't ours.
			expect(deps.getWebhookSecret).not.toHaveBeenCalled();
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the project has no webhook secret configured', async () => {
			const { app, enqueue } = makeApp({
				getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue(null),
			});
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the signature does not verify', async () => {
			const { app, enqueue } = makeApp({
				verifySignature: vi.fn<WebhookReceiverDeps['verifySignature']>().mockReturnValue(false),
			});
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('passes the raw body (not a re-serialized copy) to signature verification', async () => {
			// A body with unusual spacing would not survive a JSON round-trip; assert
			// the exact received bytes reach the verifier.
			const raw = '{"action":"opened",   "number":1}';
			const verifySignature = vi.fn<WebhookReceiverDeps['verifySignature']>().mockReturnValue(true);
			const { app } = makeApp({ verifySignature });
			await post(app, raw);
			expect(verifySignature).toHaveBeenCalledWith(raw, 'sha256=abc', 'whsec');
		});

		it('drops a self-authored comment event (loop prevention) without enqueueing', async () => {
			const adapter = {
				parseWebhook: vi
					.fn()
					.mockReturnValue({ ...prEvent, isCommentEvent: true, actorLogin: 'swarm-bot' }),
				isSelfAuthored: vi.fn().mockResolvedValue(true),
			} as unknown as GitHubRouterAdapter;
			const { app, enqueue } = makeApp({ adapter });
			const res = await post(app, VALID_BODY, { 'x-github-event': 'issue_comment' });
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('enqueues with deliveryId undefined when the delivery header is absent', async () => {
			const { app, enqueue } = makeApp();
			// Bypass the `post` helper, which always injects x-github-delivery.
			const res = await app.request('/github/webhook', {
				method: 'POST',
				headers: {
					'x-github-event': 'pull_request',
					'x-hub-signature-256': 'sha256=abc',
					'content-type': 'application/json',
				},
				body: VALID_BODY,
			});
			expect(res.status).toBe(202);
			expect(enqueue).toHaveBeenCalledWith(prEvent, project, undefined);
		});

		it('logs and returns 500 when a collaborator throws', async () => {
			const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			const { app } = makeApp({
				enqueue: vi
					.fn<WebhookReceiverDeps['enqueue']>()
					.mockRejectedValue(new Error('queue unreachable')),
			});
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ ok: false, reason: 'internal error' });
			expect(errorSpy).toHaveBeenCalled();
			errorSpy.mockRestore();
		});
	});

	describe('POST /github/webhook — projects_v2_item', () => {
		const pmEvent: GitHubProjectsParsedEvent = {
			eventType: 'projects_v2_item',
			action: 'edited',
			itemNodeId: 'PVTI_x',
			projectNodeId: 'PVT_kwHOAC3TF84BcNwD',
			changedFieldNodeId: 'PVTSSF_x',
			changedFieldType: 'single_select',
			actorLogin: 'human-dev',
		};

		/** App whose PM collaborators are all faked on the happy path. */
		function makePmApp(overrides: Partial<WebhookReceiverDeps> = {}) {
			const enqueueProjects = vi
				.fn<WebhookReceiverDeps['enqueueProjects']>()
				.mockResolvedValue(undefined);
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(pmEvent),
				isStatusChange: vi.fn().mockReturnValue(true),
				isSelfAuthored: vi.fn().mockResolvedValue(false),
			} as unknown as GitHubProjectsRouterAdapter;

			const app = createWebhookApp({
				pmAdapter,
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue('whsec'),
				verifySignature: vi.fn<WebhookReceiverDeps['verifySignature']>().mockReturnValue(true),
				enqueueProjects,
				...overrides,
			});
			return { app, enqueueProjects, pmAdapter };
		}

		function postPm(
			app: ReturnType<typeof makePmApp>['app'],
			headers: Record<string, string> = {},
		) {
			return app.request('/github/webhook', {
				method: 'POST',
				headers: {
					'x-github-event': 'projects_v2_item',
					'x-hub-signature-256': 'sha256=abc',
					'x-github-delivery': 'delivery-pm',
					'content-type': 'application/json',
					...headers,
				},
				body: JSON.stringify({ action: 'edited' }),
			});
		}

		it('accepts and enqueues a verified, human-authored status change', async () => {
			const { app, enqueueProjects } = makePmApp();
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ ok: true, accepted: true });
			expect(enqueueProjects).toHaveBeenCalledWith(pmEvent, project, 'delivery-pm');
		});

		it('ignores an unactionable projects_v2_item payload', async () => {
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(null),
				isStatusChange: vi.fn(),
				isSelfAuthored: vi.fn(),
			} as unknown as GitHubProjectsRouterAdapter;
			const { app, enqueueProjects } = makePmApp({ pmAdapter });
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('ignores an event for an untracked board (before touching secrets)', async () => {
			const getWebhookSecret = vi
				.fn<WebhookReceiverDeps['getWebhookSecret']>()
				.mockResolvedValue('whsec');
			const { app, enqueueProjects } = makePmApp({
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(undefined),
				getWebhookSecret,
			});
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(getWebhookSecret).not.toHaveBeenCalled();
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the project has no webhook secret configured', async () => {
			const { app, enqueueProjects } = makePmApp({
				getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue(null),
			});
			const res = await postPm(app);
			expect(res.status).toBe(401);
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the signature does not verify', async () => {
			const { app, enqueueProjects } = makePmApp({
				verifySignature: vi.fn<WebhookReceiverDeps['verifySignature']>().mockReturnValue(false),
			});
			const res = await postPm(app);
			expect(res.status).toBe(401);
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('ignores a non-Status field edit without enqueueing', async () => {
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(pmEvent),
				isStatusChange: vi.fn().mockReturnValue(false),
				isSelfAuthored: vi.fn().mockResolvedValue(false),
			} as unknown as GitHubProjectsRouterAdapter;
			const { app, enqueueProjects } = makePmApp({ pmAdapter });
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).reason).toBe('not a status-field change');
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('drops a self-authored status change (loop prevention)', async () => {
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(pmEvent),
				isStatusChange: vi.fn().mockReturnValue(true),
				isSelfAuthored: vi.fn().mockResolvedValue(true),
			} as unknown as GitHubProjectsRouterAdapter;
			const { app, enqueueProjects } = makePmApp({ pmAdapter });
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueueProjects).not.toHaveBeenCalled();
		});
	});

	// The receiver tests above inject a fake `verifySignature`; these exercise the
	// real `verifyGitHubSignature` wired by `defaultDeps()`, so a regression that
	// points the default at the wrong function is caught.
	describe('real signature verification (defaultDeps wiring)', () => {
		const secret = 'topsecret';

		function realVerifierApp() {
			const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);
			const adapter = {
				parseWebhook: vi.fn().mockReturnValue(prEvent),
				isSelfAuthored: vi.fn().mockResolvedValue(false),
			} as unknown as GitHubRouterAdapter;
			// Fake only the secret + repo lookups; leave verifySignature to the default.
			const app = createWebhookApp({
				adapter,
				findProject: vi
					.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue(secret),
				enqueue,
			});
			return { app, enqueue };
		}

		it('accepts a body signed with the genuine HMAC-SHA256 signature', async () => {
			const { app, enqueue } = realVerifierApp();
			const signature = `sha256=${createHmac('sha256', secret).update(VALID_BODY, 'utf8').digest('hex')}`;
			const res = await post(app, VALID_BODY, { 'x-hub-signature-256': signature });
			expect(res.status).toBe(202);
			expect(enqueue).toHaveBeenCalledWith(prEvent, project, 'delivery-1');
		});

		it('rejects a body whose real signature does not match with 401', async () => {
			const { app, enqueue } = realVerifierApp();
			const signature = `sha256=${createHmac('sha256', 'wrong-secret').update(VALID_BODY, 'utf8').digest('hex')}`;
			const res = await post(app, VALID_BODY, { 'x-hub-signature-256': signature });
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});
	});
});
