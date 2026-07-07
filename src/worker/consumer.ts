/**
 * The worker's job processor — the Phase-3 wiring: dequeued job → trigger
 * lookup → pipeline phase (ai/ARCHITECTURE.md "Components").
 *
 * A matched trigger names one of the pipeline phases plus its inputs
 * (`src/triggers/types.ts`); this dispatches on that phase and hands off to the
 * phase orchestrator (`src/pipeline/*`), which owns the whole run — worktree
 * provisioning + environment graft (SWARM-14/15), the agent CLI (SWARM-16),
 * reading its hand-off file, posting back to the PM board, and cleanup. The
 * worker's job here is just to resolve the project, build the PM provider the
 * PM-driven phases need, and translate the phase's result (or failure) into a
 * `JobOutcome`.
 *
 * Queue-agnostic on purpose: `processJob` takes an already-validated `SwarmJob`
 * and knows nothing about BullMQ, so tests drive it directly and the entry
 * point (`src/worker/index.ts`) stays a thin shell.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import type { AgentCliResult } from '../harness/agent-cli.js';
import { type AgentFailure, AgentRunError } from '../harness/agent-failure.js';
import { createGitHubProjectsProvider } from '../integrations/pm/github-projects/provider.js';
import { logger } from '../lib/logger.js';
import { runImplementationPhase } from '../pipeline/implementation.js';
import { runPlanningPhase } from '../pipeline/planning.js';
import { runRespondToCiPhase } from '../pipeline/respond-to-ci.js';
import { runRespondToReviewPhase } from '../pipeline/respond-to-review.js';
import { runReviewPhase } from '../pipeline/review.js';
import type { SwarmJob } from '../queue/jobs.js';
import type { TriggerRegistry } from '../triggers/registry.js';
import type { TriggerContext, TriggerPhase, TriggerResult } from '../triggers/types.js';

/** What became of a dequeued job — returned to BullMQ as the job's result. */
export type JobOutcome =
	| { status: 'no-trigger' }
	| {
			status: 'phase-succeeded';
			phase: TriggerPhase;
			taskId: string;
			exitCode: number | null;
			signal: NodeJS.Signals | null;
			timedOut: boolean;
			durationMs: number;
	  }
	| {
			status: 'phase-failed';
			phase: TriggerPhase;
			taskId: string;
			error: string;
	  }
	| {
			status: 'phase-deferred';
			phase: TriggerPhase;
			taskId: string;
			/** How long the worker should wait before re-enqueuing this job. */
			retryDelayMs: number;
			/** The originating failure message, for the re-enqueue log line. */
			reason: string;
			/** The retry attempt count *before* this deferral (0 on the first). */
			attempt: number;
	  };

/**
 * A persistent usage/session limit — or a run that keeps getting aborted —
 * shouldn't retry forever. Cap the loop so a genuinely exhausted quota (or a
 * misclassified failure, or a job that reliably crashes the worker) eventually
 * surfaces as a real `phase-failed` instead of re-enqueuing indefinitely. Shared
 * across both deferral reasons below — one job doesn't get two independent
 * budgets.
 */
const MAX_RATE_LIMIT_RETRIES = 6;
/**
 * Floor on the retry delay, deliberately above the review-dispatch-dedup TTL
 * (5 min, `src/triggers/review-dispatch-dedup.ts`): a review retry that fires
 * only after the claim has expired re-acquires it cleanly, so we never have to
 * release/refresh a claim that a *generic* failed run might have posted under.
 * A rate-limited or aborted run never posted anything anyway, but the retry
 * still has to land after the claim it (may have) left behind expires — this
 * is also the flat delay used for an `aborted` retry (see
 * {@link retryDelayForFailure}), which has no reset time to compute from.
 */
const MIN_RETRY_DELAY_MS = 6 * 60 * 1000;
/** Ceiling, so a mis-parsed reset time can't defer a job for an absurd span. */
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
/** Backoff when the CLI gave no parseable reset time — likely lands past reset. */
const DEFAULT_RETRY_DELAY_MS = 30 * 60 * 1000;
/** Fire slightly *after* the reported reset so quota is actually back. */
const RETRY_BUFFER_MS = 60 * 1000;

/**
 * Turn a deferrable failure into a clamped retry delay. An `aborted` run (the
 * worker's own shutdown killed it — a dev `--watch` restart, a deploy, a
 * graceful SIGTERM/SIGINT) has no "resets at…" hint to parse and needs none:
 * by the time a re-enqueued job is dequeued, the worker that killed it has
 * already finished restarting, so the only reason to wait at all is the same
 * dedup-claim floor a rate-limit retry respects.
 */
function retryDelayForFailure(failure: AgentFailure, now: number): number {
	if (failure.kind === 'aborted') return MIN_RETRY_DELAY_MS;
	const raw = failure.retryAfter
		? failure.retryAfter.getTime() - now + RETRY_BUFFER_MS
		: DEFAULT_RETRY_DELAY_MS;
	return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, raw));
}

/**
 * Handle a deferrable {@link AgentRunError} (`rate-limit` or `aborted`) —
 * `processJob`'s one non-terminal failure path, split out to keep that
 * function's branching within the complexity budget. Returns the
 * `phase-deferred` outcome to return from `processJob`, or `undefined` when
 * the retry budget is exhausted (the caller falls through to its own
 * `phase-failed` logging/return).
 */
function deferAgentRunError(
	failure: AgentFailure,
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
	error: string,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	const attempt = job.rateLimitRetryAttempt ?? 0;
	if (attempt >= MAX_RATE_LIMIT_RETRIES) {
		logger.error('Pipeline phase deferred failure — retry budget exhausted, failing', {
			projectId,
			phase: trigger.phase,
			taskId: trigger.taskId,
			attempt,
			error,
		});
		return undefined;
	}

	const retryDelayMs = retryDelayForFailure(failure, Date.now());
	logger.warn(
		failure.kind === 'aborted'
			? 'Pipeline phase aborted by worker shutdown — deferring retry'
			: 'Pipeline phase rate-limited — deferring retry',
		{
			projectId,
			phase: trigger.phase,
			taskId: trigger.taskId,
			attempt,
			retryDelayMs,
			resetHint: failure.resetHint,
			error,
		},
	);
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs,
		reason: error,
		attempt,
	};
}

/**
 * Run the pipeline phase a matched trigger resolved to. The orchestrators
 * differ in their inputs but all resolve to a result carrying the agent run
 * (`.agent`); the phase owns its own worktree lifecycle, so this doesn't
 * provision anything. `signal` (the worker's shutdown signal) is threaded
 * through so a graceful shutdown kills any in-flight agent CLI.
 */
function runPhase(
	trigger: TriggerResult,
	project: ProjectConfig,
	signal?: AbortSignal,
): Promise<{ agent: AgentCliResult }> {
	switch (trigger.phase) {
		case 'planning':
			return runPlanningPhase({
				project,
				workItem: trigger.workItem,
				taskId: trigger.taskId,
				pm: createGitHubProjectsProvider(project),
				cli: project.agents?.planning?.cli,
				model: project.agents?.planning?.model,
				autoAdvance: project.pipeline?.planning?.autoAdvance,
				signal,
			});
		case 'implementation':
			return runImplementationPhase({
				project,
				workItem: trigger.workItem,
				taskId: trigger.taskId,
				pm: createGitHubProjectsProvider(project),
				cli: project.agents?.implementation?.cli,
				model: project.agents?.implementation?.model,
				autoAdvance: project.pipeline?.implementation?.autoAdvance,
				signal,
			});
		case 'review':
			return runReviewPhase({
				project,
				prNumber: trigger.prNumber,
				headSha: trigger.headSha,
				taskId: trigger.taskId,
				cli: project.agents?.review?.cli,
				model: project.agents?.review?.model,
				signal,
			});
		case 'respond-to-review':
			return runRespondToReviewPhase({
				project,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				reviewId: trigger.reviewId,
				taskId: trigger.taskId,
				cli: project.agents?.respondToReview?.cli,
				model: project.agents?.respondToReview?.model,
				signal,
			});
		case 'respond-to-ci':
			return runRespondToCiPhase({
				project,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
				taskId: trigger.taskId,
				cli: project.agents?.respondToCi?.cli,
				model: project.agents?.respondToCi?.model,
				signal,
			});
	}
}

/**
 * Process one dequeued job end to end.
 *
 * A job no handler claims completes as `no-trigger`. A job whose phase ran but
 * failed — the agent exited non-zero, a hand-off file was missing, or worktree
 * setup failed — completes as `phase-failed` rather than throwing: an agent run
 * isn't idempotent, so a BullMQ retry storm is worse than surfacing the failure
 * in the outcome (the phase already logs the agent's own stdout/stderr, and
 * reporting to the PM board is the phase's job). The one thing that still
 * throws is an unknown project — infrastructure the job can't proceed without.
 *
 * The exception to "failed phases don't retry" is a deferrable
 * {@link AgentRunError}: a usage/session-limit hit (classified `rate-limit`,
 * issue #91) or a run the worker itself cancelled (classified `aborted` — the
 * *worker* shutting down while a phase was mid-run, e.g. a dev `--watch`
 * restart, a deploy, or a graceful SIGTERM/SIGINT; confirmed live when
 * unrelated code edits during active development kept restarting the worker
 * mid-review and permanently failing it, since a SIGTERM-killed run doesn't
 * look like a rate limit and there was no other path back to `phase-deferred`).
 * Either way the agent never did any *lasting* work of its own accord, so
 * instead of `phase-failed` this returns `phase-deferred` with a delay, and the
 * worker entrypoint re-enqueues the job once it's safe to retry. Capped at
 * {@link MAX_RATE_LIMIT_RETRIES} so a persistent limit — or a job that reliably
 * crashes the worker — eventually surfaces as a real failure.
 *
 * `signal` is the worker's shutdown signal: aborting kills a running agent CLI
 * (SIGTERM→SIGKILL) so graceful shutdown doesn't hang behind a long run.
 */
export async function processJob(
	job: SwarmJob,
	registry: TriggerRegistry,
	signal?: AbortSignal,
): Promise<JobOutcome> {
	const project = await findProjectByIdFromDb(job.projectId);
	if (!project) {
		// The producer only enqueues for projects it resolved from Postgres, so a
		// miss here means the project was deleted mid-flight — fail loudly.
		throw new Error(`Job references unknown project '${job.projectId}'`);
	}

	const ctx: TriggerContext =
		job.type === 'github'
			? {
					project,
					deliveryId: job.deliveryId,
					recheckAttempt: job.recheckAttempt,
					source: 'github',
					event: job.event,
				}
			: {
					project,
					deliveryId: job.deliveryId,
					recheckAttempt: job.recheckAttempt,
					source: 'github-projects',
					event: job.event,
				};

	const trigger = await registry.dispatch(ctx);
	if (!trigger) {
		logger.info('Job matched no trigger — completing as a no-op', {
			projectId: project.id,
			source: ctx.source,
			eventType: job.event.eventType,
			deliveryId: job.deliveryId,
		});
		return { status: 'no-trigger' };
	}

	try {
		const result = await runPhase(trigger, project, signal);
		logger.info('Pipeline phase completed', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
		});
		return {
			status: 'phase-succeeded',
			phase: trigger.phase,
			taskId: trigger.taskId,
			exitCode: result.agent.exitCode,
			signal: result.agent.signal,
			timedOut: result.agent.timedOut,
			durationMs: result.agent.durationMs,
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);

		// A usage/session-limit hit or a worker-shutdown abort is transient: the
		// agent never did any lasting work, so rather than failing the job we defer
		// it and let the worker re-enqueue it once it's safe to retry (rate-limit:
		// issue #91; aborted: the run was killed by the worker's own shutdown, not
		// by anything the agent did). Capped so a persistent limit — or a job that
		// keeps getting aborted, or a misclassified failure — can't loop forever.
		const isDeferrable =
			err instanceof AgentRunError &&
			(err.failure.kind === 'rate-limit' || err.failure.kind === 'aborted');
		if (isDeferrable) {
			const deferred = deferAgentRunError(err.failure, job, trigger, project.id, error);
			if (deferred) return deferred;
		}

		logger.error('Pipeline phase failed', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error,
		});
		// The review handler's claim intentionally survives a failed run: the review
		// agent submits its formal `gh pr review` *inside* the run, so a phase that
		// threw afterward may have already posted the review — releasing the claim
		// here would let a sibling event for the same PR+SHA post a duplicate, the
		// exact incident the dedup guards against. The 5-minute TTL reaps a claim
		// whose run genuinely failed before submitting. See review-dispatch-dedup.ts.
		return { status: 'phase-failed', phase: trigger.phase, taskId: trigger.taskId, error };
	}
}
