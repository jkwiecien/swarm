/**
 * The router→worker job contract — the one shape both sides of the queue speak
 * (PROJECT.md §5 "Orchestration Input", trimmed to the MVP's local BullMQ).
 *
 * The router's producer (SWARM-35, at the `src/router/enqueue.ts` seam) turns an
 * authenticated, project-matched webhook event into one of these jobs; the
 * worker's consumer (`src/worker/consumer.ts`) validates it back through this
 * schema before acting. A job carries the already-parsed event — not the raw
 * webhook body — so the worker never re-does the router's parsing, plus the
 * project id (config is re-read from Postgres on the worker side, never
 * serialized into the job) and GitHub's delivery id for idempotency/tracing.
 *
 * The `type` discriminator matches the producing router adapter's `type` const
 * (`github` / `github-projects`).
 */

import { z } from 'zod';
import { GitHubParsedEventSchema } from '../router/adapters/github.js';
import { GitHubProjectsParsedEventSchema } from '../router/adapters/github-projects.js';

/** The single BullMQ queue the router produces onto and the worker consumes. */
export const QUEUE_NAME = 'swarm-jobs';

const jobBase = z.object({
	/** The SWARM project (`ProjectConfig.id`) the event was matched to. */
	projectId: z.string().min(1),
	/** GitHub's `X-GitHub-Delivery` header — stable per webhook delivery. */
	deliveryId: z.string().min(1).optional(),
	/**
	 * How many times this job has already been re-enqueued as a deferred
	 * incomplete-check recheck (`src/triggers/handlers/review.ts`). Absent on a
	 * fresh webhook; incremented each time the `pr-review` handler reschedules a
	 * coalesced recheck, so it can cap the loop when the Actions API stays stale.
	 */
	recheckAttempt: z.number().int().nonnegative().optional(),
	/**
	 * How many times this job has already been re-enqueued as a deferred retry
	 * (`src/worker/index.ts`, on a `phase-deferred` outcome) — either a rate-limit
	 * hit or a run the worker itself aborted mid-flight (e.g. a `--watch`
	 * restart). Absent on a fresh webhook; incremented on each deferral so the
	 * consumer can cap the retry loop (one shared budget for both reasons —
	 * `src/worker/consumer.ts`'s `MAX_RATE_LIMIT_RETRIES`) when either persists.
	 */
	rateLimitRetryAttempt: z.number().int().nonnegative().optional(),
	/**
	 * PM phase to resume after an agent failure. A retried implementation has
	 * already moved its card to In progress, which normally is deliberately not
	 * a phase-triggering status; this preserves the original dispatch intent.
	 */
	resumePmPhase: z.enum(['planning', 'implementation']).optional(),
});

/** An SCM webhook event (`pull_request`, `issue_comment`, …) bound for the worker. */
export const GitHubWebhookJobSchema = jobBase.extend({
	type: z.literal('github'),
	event: GitHubParsedEventSchema,
});

/** A `projects_v2_item` board event (Status change / card added) bound for the worker. */
export const GitHubProjectsWebhookJobSchema = jobBase.extend({
	type: z.literal('github-projects'),
	event: GitHubProjectsParsedEventSchema,
});

export const SwarmJobSchema = z.discriminatedUnion('type', [
	GitHubWebhookJobSchema,
	GitHubProjectsWebhookJobSchema,
]);

export type GitHubWebhookJob = z.infer<typeof GitHubWebhookJobSchema>;
export type GitHubProjectsWebhookJob = z.infer<typeof GitHubProjectsWebhookJobSchema>;
export type SwarmJob = z.infer<typeof SwarmJobSchema>;
