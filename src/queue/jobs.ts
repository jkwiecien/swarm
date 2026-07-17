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
import { AgentCliSchema } from '../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../harness/models.js';
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
	 * Board-dispatch concern only (github-projects jobs) — session continuation is
	 * the separate {@link resumeSession} flag, which spans every phase and CLI.
	 */
	resumePmPhase: z.enum(['planning', 'implementation']).optional(),
	/**
	 * Durable proof that Implementation successfully provisioned its task branch.
	 * A manual retry needs `resumePmPhase` to preserve dispatch intent after the
	 * card moved to In progress, but must not reuse a branch unless provisioning
	 * actually completed.
	 */
	implementationBranchProvisioned: z.boolean().optional(),
	/**
	 * Set on a deferred retry that should *continue the prior agent session*
	 * rather than start fresh (a `rate-limit`/`timeout` deferral, any phase, any
	 * CLI). When set, the consumer threads {@link agentSessionId} into the phase
	 * as a resume id (`claude --resume` / `agy --conversation` /
	 * `codex exec resume`) and the phase reuses the preserved worktree; when
	 * absent, the run starts a fresh session and, for claude, assigns
	 * `agentSessionId` as its new `--session-id`.
	 */
	resumeSession: z.boolean().optional(),
	/**
	 * Set on a deterministic-delivery retry. Unlike {@link resumeSession}, this
	 * resumes a preserved worktree and its delivery sidecar without requiring an
	 * agent CLI session to exist.
	 */
	resumeDelivery: z.boolean().optional(),
	/**
	 * The `runs` row this job re-runs (issue #136). Absent on a fresh webhook;
	 * set when a deferred run is re-enqueued (`reenqueueDeferred`
	 * `src/worker/index.ts`, or a manual "Retry now") so the worker resets that
	 * existing row to `running` instead of inserting a second one — a retry then
	 * shows as one run on the dashboard, not two. When absent, the consumer
	 * creates a fresh row as before.
	 */
	runId: z.string().min(1).optional(),
	/**
	 * Persisted agent session/thread id for a resumable deferred run — the value
	 * threaded back as the CLI's resume id on retry. UUID-shaped for every CLI:
	 * claude's assigned `--session-id`, codex's `thread_id`, and agy's conversation
	 * id are all UUIDs (verified live). Not claude-only anymore.
	 */
	agentSessionId: z.string().uuid().optional(),
	/** Optional overrides for retrying/running with a specific agent CLI and model. */
	cliOverride: AgentCliSchema.optional(),
	modelOverride: z.string().min(1).optional(),
	/**
	 * Optional per-run reasoning-level override (issue #180). Validated against the
	 * effective model when resolved (`resolveReasoning`, `src/worker/consumer.ts`),
	 * so a level incompatible with an overridden CLI/model is dropped rather than
	 * launched. Rides `...jobPayload` spreads through deferred/manual retries.
	 */
	reasoningOverride: ReasoningLevelSchema.optional(),
	/**
	 * Set on a concurrency-deferred continuation's retry (issue #214): its dispatch
	 * dedup slot was already claimed by the original dispatch attempt, so the
	 * re-dispatch must NOT re-claim it — a prioritized retry fires within the
	 * (refreshed) claim TTL, and re-claiming would drop the run as a duplicate. The
	 * `pr-review` handler reads it to reuse the held claim instead of calling
	 * `claimReviewDispatch`. Board jobs never set it.
	 */
	continuationDispatchClaimed: z.boolean().optional(),
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
