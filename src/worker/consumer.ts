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

import type { AgentDefaults, ProjectConfig } from '../config/schema.js';
import { getAppSettings } from '../db/repositories/appSettingsRepository.js';
import { upsertCliQuota } from '../db/repositories/cliQuotasRepository.js';
import {
	cancelClaimedDispatch,
	completeDispatch,
	type DispatchRow,
	type DispatchWaitReason,
	deferDispatchToPending,
	failDispatch,
	markDispatchRunning,
	recordDispatchResolution,
	scheduleDispatchRetry,
} from '../db/repositories/dispatchesRepository.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	appendRunOutputEvents,
	type CompleteRunInput,
	completeRun,
	createRun,
	getLatestRunForTask,
	getRunByIdFromDb,
	hasCompletedRunForTask,
	MAX_RUN_OUTPUT_BYTES,
	resetRunToRunning,
	storeRunLogs,
	updateRunJobPayload,
} from '../db/repositories/runsRepository.js';
import {
	claimDispatchForJob,
	createAndPublishDispatch,
	parseDispatchPayload,
	promoteNextCapacityDispatch,
	publishDispatchWakeUp,
} from '../dispatch/dispatcher.js';
import { deriveCapacityPendingPayload, deriveRetryJobPayload } from '../dispatch/retry-payload.js';
import { type AgentCli, type AgentCliResult, runAgentCli } from '../harness/agent-cli.js';
import {
	type AgentFailure,
	type AgentFailureKind,
	AgentRunError,
	agentRunError,
} from '../harness/agent-failure.js';
import {
	capabilityFor,
	DEFAULT_MODEL_PER_CLI,
	isReasoningLevel,
	type ReasoningLevel,
} from '../harness/models.js';
import { discoverCliQuotas } from '../harness/quota-discovery.js';
import { createGitHubProjectsProvider } from '../integrations/pm/github-projects/provider.js';
import { GitHubSCMIntegration } from '../integrations/scm/github/scm-integration.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { DependencyBlockedError } from '../pipeline/dependency-guard.js';
import { runImplementationPhase } from '../pipeline/implementation.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import { runPlanningPhase } from '../pipeline/planning.js';
import { runResolveConflictsPhase } from '../pipeline/resolve-conflicts.js';
import { runRespondToCiPhase } from '../pipeline/respond-to-ci.js';
import { runRespondToReviewPhase } from '../pipeline/respond-to-review.js';
import { BlockedRecoveryError } from '../pipeline/resume.js';
import {
	type ReviewAutomationOutcome,
	type ReviewVerdict,
	runReviewPhase,
} from '../pipeline/review.js';
import { type PmStatusKey, resolvePipelinePhaseForStatusKey } from '../pm/pipeline.js';
import type { WorkItem } from '../pm/types.js';
import {
	type CancellationOrigin,
	clearRunCancellation,
	getRunCancellationOrigin,
	isRunCancellationRequested,
	RUN_CANCELLED_MESSAGE,
} from '../queue/cancellation.js';
import {
	type GitHubProjectsWebhookJob,
	type GitHubWebhookJob,
	type SwarmJob,
	SwarmJobSchema,
} from '../queue/jobs.js';
import { priorityFor } from '../queue/producer.js';
import { DeliveryDeferredError } from '../scm/delivery.js';
import type { TriggerRegistry } from '../triggers/registry.js';
import {
	buildConflictResolutionKey,
	refreshConflictResolutionClaim,
} from '../triggers/resolve-conflicts-dedup.js';
import {
	buildReviewDispatchKey,
	refreshReviewDispatchClaim,
	releaseReviewDispatch,
} from '../triggers/review-dispatch-dedup.js';
import {
	isPrioritizedContinuationPhase,
	type TriggerContext,
	type TriggerPhase,
	type TriggerResult,
} from '../triggers/types.js';
import {
	maxDependencyRechecks,
	resolveDependencyMaxWaitMs,
	resolveDependencyRecheckIntervalMs,
} from './dependency-recheck.js';
import { WorktreeAlreadyExistsError } from './git-worktree-manager.js';
import {
	type MergeAutomationSettledOutcome,
	processMergeAutomationDispatch,
	requestMergeAutomation,
} from './merge-automation.js';
import { acquireProjectSlot, releaseProjectSlot } from './project-concurrency.js';
import {
	beginRunCancellationTracking,
	linkRunAbortController,
	unregisterRunController,
} from './run-cancellation.js';
import {
	loadAvailableClis,
	selectTarget,
	type TargetSelection,
	type WorkerCliAvailability,
} from './target-selection.js';

/** What became of a dequeued job — returned to BullMQ as the job's result. */
export type JobOutcome =
	| { status: 'no-trigger' }
	| {
			/**
			 * The wake-up's dispatch record refused the claim (cancelled, completed,
			 * superseded, held elsewhere, or a duplicate attempt for a run that
			 * already has one) — the delivery is dropped without touching anything
			 * (issue #284): terminal dispatch states cannot be resurrected.
			 */
			status: 'dispatch-refused';
			reason: string;
	  }
	| { status: 'skipped-in-flight'; phase: TriggerPhase; taskId: string }
	// A merge-automation dispatch settled (merged, refused, retry-scheduled, or
	// failed) — the agent-less dispatch kind (issue #292).
	| MergeAutomationSettledOutcome
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
			/**
			 * True when this failure is a cancellation (the durable marker was found
			 * set), not an agent/provider failure — drives the dispatch-settle branch's
			 * cancel-vs-fail choice structurally instead of string-comparing `error`.
			 */
			cancelled?: boolean;
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
			/**
			 * True for a rate-limit or genuinely-interrupted-timeout deferral (any
			 * phase, any CLI): the retry should resume the preserved session rather
			 * than start fresh. Drives `resumeSession` on the re-enqueued job and
			 * whether the captured `agentSessionId` is kept on the deferred row.
			 */
			resumable: boolean;
			/** True when the retry must reuse deterministic-delivery progress, not an agent session. */
			resumeDelivery?: boolean;
			/**
			 * True when a PM-driven phase was actually entered before it deferred.
			 * This preserves board dispatch intent without implying that
			 * Implementation successfully provisioned its task branch.
			 */
			pmPhaseStarted?: boolean;
			/**
			 * The `runs` row this deferral belongs to (issue #136), when one was
			 * created/reused for this job. Carried onto the re-enqueued job so the
			 * retry resets the same row instead of inserting a new one. Absent when
			 * the deferral happened before a run row could be persisted.
			 */
			runId?: string;
			/**
			 * Set when this is a prioritized continuation deferral (issue #214): its
			 * dispatch dedup claim is being held open, so `reenqueueDeferred` threads
			 * `continuationDispatchClaimed` onto the retry job — the handler reuses the
			 * held claim rather than re-claiming (which would drop the run as a duplicate).
			 */
			continuationDispatchClaimed?: boolean;
			/**
			 * Set when this deferral should be retained in the pending-continuation
			 * registry (issue #214), so a freed project slot promotes its delayed retry
			 * ahead of new board work. `reenqueueDeferred` registers it after enqueuing
			 * the fallback retry.
			 */
			pendingContinuation?: boolean;
			/**
			 * A project-slot deferral. Unlike a provider failure, its dispatch is
			 * returned to `pending` (wait reason `project-capacity`) and awakened
			 * only by a released slot, not a timer.
			 */
			pendingDispatch?: boolean;
			/**
			 * The classified failure kind behind a scheduled-retry deferral — maps
			 * onto the dispatch record's wait reason so the Queue UI can explain
			 * *why* the retry is waiting (issue #284).
			 */
			failureKind?: DeferrableFailure['kind'];
			/**
			 * A dependency re-check deferral (issue #330), not an agent failure: the
			 * dispatch waits (`recheck`) on an unfinished prerequisite and consumes the
			 * separate {@link SwarmJob.dependencyRecheckAttempt} budget, leaving the
			 * rate-limit budget untouched.
			 */
			dependencyRecheck?: boolean;
	  };

/**
 * A persistent usage/session limit — or a run that keeps getting aborted —
 * shouldn't retry forever. Cap the loop so a genuinely exhausted quota (or a
 * misclassified failure, or a job that reliably crashes the worker) eventually
 * surfaces as a real `phase-failed` instead of re-enqueuing indefinitely.
 */
const MAX_RATE_LIMIT_RETRIES = 6;
/**
 * Capacity is transient, but retrying the same saturated model repeatedly is
 * unlikely to help. Allow two short retries, then suggest another configured
 * model instead of applying the longer quota-reset policy.
 */
const MAX_CAPACITY_RETRIES = 2;
/**
 * Dependency re-check cadence + budget (issue #330). A blocked Implementation
 * re-checks its prerequisites every {@link DEPENDENCY_RECHECK_INTERVAL_MS} — a
 * token-free deferral (the gate runs before any worktree/agent) — for up to
 * {@link MAX_DEPENDENCY_RECHECKS} attempts, then settles failed with an actionable
 * "must be done first" message rather than waiting forever. Both derived from env
 * (`SWARM_DEPENDENCY_RECHECK_MS` / `SWARM_DEPENDENCY_MAX_WAIT_MS`).
 */
const DEPENDENCY_RECHECK_INTERVAL_MS = resolveDependencyRecheckIntervalMs();
const MAX_DEPENDENCY_RECHECKS = maxDependencyRechecks(
	DEPENDENCY_RECHECK_INTERVAL_MS,
	resolveDependencyMaxWaitMs(),
);
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
 * TTL the review-dispatch claim is refreshed while an SCM continuation is held
 * pending. The released job carries that claim and therefore never replays the
 * status/webhook dedup path as fresh work.
 */
const PENDING_CONTINUATION_CLAIM_TTL_SEC = Math.ceil(MIN_RETRY_DELAY_MS / 1000) + 120;

/**
 * Coded default wall-clock timeout applied to *every* phase/agent invocation
 * when a project sets no per-phase `agents.<phase>.timeoutMs` (issue #165).
 * Without it an agent that hangs — a model that never responds, a wedged CLI —
 * runs forever, holding a worker slot and leaving its run row stuck `running`
 * (confirmed live on run `dd0ad860-…`). Chosen as a 30-minute default: long
 * enough for a focused phase, while bounding a runaway run's quota use and
 * occupied worker slot. Override the
 * default globally with the `SWARM_AGENT_TIMEOUT_MS` env var
 * (README § Configuration); a per-phase `timeoutMs` in `swarm.config.json`
 * still wins over both.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The coded default agent CLI — used when neither a per-job override nor a phase
 * config names one. Every pipeline phase's own coded default (`DEFAULT_*_CLI` in
 * `src/pipeline/*.ts`) is `claude`, so this is the CLI a defaulted run actually
 * launches; keep it in sync if a phase default ever changes. It resolves the
 * effective engine persisted on the run row (issue #169) and keys the model
 * fallback maps in {@link resolveModel}. Exported so a unit test can assert it
 * stays equal to every phase's coded `DEFAULT_*_CLI`, guarding the drift the
 * "keep in sync" note above warns about (issue #169).
 */
export const DEFAULT_ENGINE: AgentCli = 'claude';

/**
 * Resolve the effective default agent timeout: `SWARM_AGENT_TIMEOUT_MS` when it
 * is set to a positive integer, else {@link DEFAULT_AGENT_TIMEOUT_MS}. Exported
 * so the worker entrypoint reuses the exact same value for its stale-run
 * reconciliation cutoff (`src/worker/index.ts`). Throws on a non-integer / <1
 * value so a typo surfaces at startup rather than silently disabling the safety
 * net.
 */
export function resolveAgentTimeoutMs(raw = process.env.SWARM_AGENT_TIMEOUT_MS): number {
	if (raw === undefined || raw === '') return DEFAULT_AGENT_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`SWARM_AGENT_TIMEOUT_MS must be a positive integer, got '${raw}'`);
	}
	return parsed;
}

/** The effective default agent timeout, resolved once at module load. */
const AGENT_TIMEOUT_MS = resolveAgentTimeoutMs();

/**
 * Lease taken when a dispatch is claimed at dequeue (issue #284) — long enough
 * to cover trigger resolution (authoritative board/check re-reads) and worktree
 * provisioning; extended to the phase's own wall-clock timeout the moment the
 * run starts (`markDispatchRunning`).
 */
const DISPATCH_CLAIM_LEASE_MS = 15 * 60 * 1000;
/**
 * Margin past the effective agent timeout before a `running` dispatch's lease
 * is considered dead — the harness's SIGTERM→SIGKILL grace plus headroom for a
 * slow finalize, mirroring the stale-run sweep's margin (`src/worker/index.ts`).
 */
const DISPATCH_LEASE_MARGIN_MS = 10 * 60 * 1000;

/** Swallow-and-log dispatch completion — bookkeeping must never fail a settled run. */
async function tryCompleteDispatch(
	dispatchId: string,
	outcome: Parameters<typeof completeDispatch>[1],
): Promise<void> {
	try {
		await completeDispatch(dispatchId, outcome);
	} catch (err) {
		logger.error('Failed to complete dispatch record (lease sweep will repair)', {
			dispatchId,
			outcome,
			error: describeError(err),
		});
	}
}

/** Swallow-and-log dispatch failure — see {@link tryCompleteDispatch}. */
async function tryFailDispatch(dispatchId: string, error: string): Promise<void> {
	try {
		await failDispatch(dispatchId, error);
	} catch (err) {
		logger.error('Failed to fail dispatch record (lease sweep will repair)', {
			dispatchId,
			error: describeError(err),
		});
	}
}

type DeferrableFailure = AgentFailure | { kind: 'delivery' };

/**
 * Turn a deferrable failure into a clamped retry delay. An `aborted` run (the
 * worker's own shutdown killed it — a dev `--watch` restart, a deploy, a
 * graceful SIGTERM/SIGINT) has no "resets at…" hint to parse and needs none:
 * by the time a re-enqueued job is dequeued, the worker that killed it has
 * already finished restarting, so the only reason to wait at all is the same
 * dedup-claim floor a rate-limit retry respects.
 */
function retryDelayForFailure(failure: DeferrableFailure, now: number): number {
	if (
		failure.kind === 'aborted' ||
		failure.kind === 'capacity' ||
		failure.kind === 'delivery' ||
		failure.kind === 'worktree-exists' ||
		failure.kind === 'stalled' ||
		// A timeout has no "resets at…" hint and needs no long wait — the run
		// simply ran long; retry after the same dedup-claim floor as an abort.
		failure.kind === 'timeout'
	)
		return MIN_RETRY_DELAY_MS;
	const raw = failure.retryAfter
		? failure.retryAfter.getTime() - now + RETRY_BUFFER_MS
		: DEFAULT_RETRY_DELAY_MS;
	return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, raw));
}

function deferredPhaseMessage(failure: DeferrableFailure, phase: TriggerPhase): string {
	switch (failure.kind) {
		case 'aborted':
			return `Phase stopped - ${phaseLabel(phase)} — worker shutdown, deferring retry`;
		case 'capacity':
			return `Phase stopped - ${phaseLabel(phase)} — model at capacity, deferring short retry`;
		case 'delivery':
			return `Phase stopped - ${phaseLabel(phase)} — delivery failed, deferring retry`;
		case 'worktree-exists':
			return `Phase stopped - ${phaseLabel(phase)} — worktree already exists, deferring retry`;
		case 'stalled':
			return `Phase stopped - ${phaseLabel(phase)} — response stalled, deferring resume retry`;
		case 'timeout':
			return `Phase stopped - ${phaseLabel(phase)} — timed out, deferring resume retry`;
		default:
			return `Phase stopped - ${phaseLabel(phase)} — rate-limited, deferring retry`;
	}
}

/**
 * Handle a deferrable {@link AgentRunError} (`rate-limit`, `capacity`, or `aborted`) —
 * `processJob`'s one non-terminal failure path, split out to keep that
 * function's branching within the complexity budget. Returns the
 * `phase-deferred` outcome to return from `processJob`, or `undefined` when
 * the retry budget is exhausted (the caller falls through to its own
 * `phase-failed` logging/return).
 */
function deferAgentRunError(
	failure: DeferrableFailure,
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
	error: string,
	runId: string | undefined,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	const attempt = job.rateLimitRetryAttempt ?? 0;
	const maxRetries = failure.kind === 'capacity' ? MAX_CAPACITY_RETRIES : MAX_RATE_LIMIT_RETRIES;
	if (attempt >= maxRetries) {
		logger.error(`Phase failed - ${phaseLabel(trigger.phase)} — retry budget exhausted`, {
			projectId,
			phase: trigger.phase,
			taskId: trigger.taskId,
			attempt,
			error,
		});
		return undefined;
	}

	const retryDelayMs = retryDelayForFailure(failure, Date.now());
	logger.warn(deferredPhaseMessage(failure, trigger.phase), {
		projectId,
		phase: trigger.phase,
		taskId: trigger.taskId,
		attempt,
		retryDelayMs,
		resetHint: 'resetHint' in failure ? failure.resetHint : undefined,
		error,
	});
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs,
		reason: error,
		attempt,
		runId,
		// A rate-limit or timeout may have interrupted useful work whose reasoning
		// lives in the agent's CLI session (and, for implementer phases, whose
		// partial edits live in the worktree) — resume it instead of redoing it.
		// Every phase and CLI now captures a resumable session id (agent-cli.ts), so
		// this is no longer gated to claude or the PM phases; a run whose session
		// wasn't captured simply persists no id and retries from scratch.
		//
		// A `capacity` deferral (Codex "at capacity", Claude 529/overloaded — issue
		// #229) deliberately stays fresh: the provider rejected the request before
		// the model did any work, so there is no partial reasoning or edit to
		// resume, and the captured session id (if any) points at a run that never
		// progressed. Starting fresh matches the pre-existing Codex-capacity
		// contract; only an explicit safety case would justify resuming instead.
		resumable:
			failure.kind === 'rate-limit' || failure.kind === 'timeout' || failure.kind === 'stalled',
		resumeDelivery: failure.kind === 'delivery' || undefined,
		pmPhaseStarted:
			job.type === 'github-projects' &&
			(trigger.phase === 'planning' || trigger.phase === 'implementation'),
		failureKind: failure.kind,
	};
}

/**
 * Handle a {@link DependencyBlockedError} (issue #330): build the token-free
 * `recheck` deferral while the dependency-recheck budget lasts, or return
 * `undefined` once it's exhausted so the caller falls through to a terminal
 * `phase-failed` that posts the "must be done first" message on the item. Split
 * out of {@link handlePhaseFailure} to keep its branching within budget, mirroring
 * {@link deferAgentRunError}.
 */
function deferDependencyBlock(
	err: DependencyBlockedError,
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
	error: string,
	runId: string | undefined,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	const attempt = job.dependencyRecheckAttempt ?? 0;
	if (attempt >= MAX_DEPENDENCY_RECHECKS) {
		logger.error(
			`Phase failed - ${phaseLabel(trigger.phase)} — still blocked after ${attempt} re-checks`,
			{ projectId, phase: trigger.phase, taskId: trigger.taskId, error },
		);
		return undefined;
	}
	logger.info(`Phase deferred - ${phaseLabel(trigger.phase)} — waiting on dependency`, {
		projectId,
		phase: trigger.phase,
		taskId: trigger.taskId,
		attempt,
		retryDelayMs: DEPENDENCY_RECHECK_INTERVAL_MS,
		blockers: err.blockers.map((b) => b.reference),
	});
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs: DEPENDENCY_RECHECK_INTERVAL_MS,
		reason: error,
		attempt,
		resumable: false,
		dependencyRecheck: true,
		// The phase was entered (its gate ran) — preserve board dispatch intent so the
		// re-check re-enters Implementation even though the card never moved.
		pmPhaseStarted:
			job.type === 'github-projects' &&
			(trigger.phase === 'planning' || trigger.phase === 'implementation'),
		runId,
	};
}

/** Map a classified deferrable failure onto the dispatch record's wait reason. */
function waitReasonForDeferral(kind: DeferrableFailure['kind'] | undefined): DispatchWaitReason {
	switch (kind) {
		case 'capacity':
			return 'agent-capacity';
		case 'aborted':
			return 'worker-shutdown';
		case 'timeout':
			return 'timeout';
		case 'stalled':
			return 'stalled';
		case 'delivery':
			return 'delivery';
		case 'worktree-exists':
			return 'worktree-exists';
		default:
			return 'rate-limit';
	}
}

/**
 * Persist the derived retry payload on the run row too (best-effort): a manual
 * "Retry now" for a legacy row with no dispatch reconstructs from it, and the
 * startup backfill uses it to rebuild lost dispatches.
 */
async function persistRetryPayloadOnRun(runId: string | undefined, job: SwarmJob): Promise<void> {
	if (!runId) return;
	try {
		await updateRunJobPayload(runId, job);
	} catch (err) {
		logger.error('Failed to persist retry payload on run row (continuing)', {
			runId,
			error: describeError(err),
		});
	}
}

/**
 * Settle a claimed dispatch as `retry-scheduled`: derive the next attempt's
 * payload, persist it durably on the dispatch (the crash-safe retry intent —
 * issue #284), then publish the delayed wake-up. A publish failure is logged,
 * not thrown — the durable record already exists and the reconciler re-publishes
 * it. A dispatch that is no longer claimed (a user cancellation settled it
 * first) is left alone: the cancel wins.
 */
async function settleDispatchRetry(
	dispatch: DispatchRow,
	job: SwarmJob,
	outcome: Extract<JobOutcome, { status: 'phase-deferred' }>,
): Promise<void> {
	const next = deriveRetryJobPayload(job, {
		phase: outcome.phase,
		runId: outcome.runId,
		resumable: outcome.resumable,
		resumeDelivery: outcome.resumeDelivery,
		pmPhaseStarted: outcome.pmPhaseStarted,
		continuationDispatchClaimed: outcome.continuationDispatchClaimed,
		dependencyRecheck: outcome.dependencyRecheck,
	});
	await persistRetryPayloadOnRun(outcome.runId, next);
	const updated = await scheduleDispatchRetry(dispatch.id, {
		jobPayload: next,
		availableAt: new Date(Date.now() + outcome.retryDelayMs),
		// A dependency deferral waits on an external condition, so it reads as a
		// `recheck` (like merge-automation), not a failure-driven wait reason, and
		// tracks its own attempt counter.
		waitReason: outcome.dependencyRecheck ? 'recheck' : waitReasonForDeferral(outcome.failureKind),
		attempt: outcome.dependencyRecheck
			? (next.dependencyRecheckAttempt ?? 0)
			: (next.rateLimitRetryAttempt ?? 0),
		runId: outcome.runId,
	});
	if (!updated) {
		logger.debug('Dispatch no longer claimed — skipping retry schedule (cancelled?)', {
			dispatchId: dispatch.id,
			taskId: outcome.taskId,
		});
		return;
	}
	try {
		await publishDispatchWakeUp(updated);
	} catch (err) {
		logger.warn('Failed to publish retry wake-up (reconciler will repair)', {
			dispatchId: dispatch.id,
			error: describeError(err),
		});
	}
}

function deferForConcurrencyLimit(
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	const reason = `Project '${projectId}' is at its concurrent-job limit`;

	logger.warn(`Phase deferred - ${phaseLabel(trigger.phase)} — project at concurrency limit`, {
		projectId,
		phase: trigger.phase,
		taskId: trigger.taskId,
	});
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs: 0,
		reason,
		attempt: job.rateLimitRetryAttempt ?? 0,
		resumable: false,
		pendingDispatch: true,
		// A fresh webhook has no row yet (this defers before `tryCreateRun`); a
		// retry carries its originating row's id, which must survive so the next
		// re-enqueue keeps resetting the same row rather than orphaning it.
		runId: job.runId,
	};
}

/**
 * Handle a job blocked by the project's concurrency limit — `processJob`'s
 * pre-run deferral path, split out so that function stays within the complexity
 * budget (the file already splits helpers this way).
 *
 * The claimed dispatch is returned to `pending` (wait reason
 * `project-capacity`) with its exact dispatch intent persisted — PM jobs carry
 * `resumePmPhase` so a stale board status cannot deduplicate the resumed
 * phase — and is woken by a freed slot, not a timer (issue #284). Its run row
 * becomes visible immediately. SCM continuations retain their dispatch dedup
 * claim and optionally receive priority over board work.
 */
async function handleConcurrencyDeferral(
	dispatch: DispatchRow,
	job: SwarmJob,
	trigger: TriggerResult,
	project: ProjectConfig,
): Promise<JobOutcome> {
	const deferred = deferForConcurrencyLimit(job, trigger, project.id);
	if (!deferred) throw new Error('Concurrency deferral must always produce a pending dispatch');

	// Every blocked phase gets a run row now. This makes new Planning and
	// Implementation work visible while it waits, rather than creating a row only
	// after a timer happens to fire.
	const runId = await tryCreateRun(
		project,
		await loadGlobalDefaults(),
		await loadAvailableClis(),
		trigger,
		job,
	);
	if (runId) deferred.runId = runId;

	// Retain a concurrency-blocked SCM phase as a prioritized continuation once
	// a slot frees.
	if (isPrioritizedContinuationPhase(trigger.phase)) {
		deferred.continuationDispatchClaimed = true;
		deferred.pendingContinuation = project.pipeline?.prioritizeContinuations !== false;
		if (trigger.phase === 'review' || trigger.phase === 'respond-to-ci') {
			// Review and Respond-to-CI share the PR+SHA dispatch slot.
			await refreshReviewDispatchClaim(
				buildReviewDispatchKey(project.repo, trigger.prNumber, trigger.headSha),
				PENDING_CONTINUATION_CLAIM_TTL_SEC,
			);
		} else if (trigger.phase === 'resolve-conflicts') {
			await refreshConflictResolutionClaim(
				buildConflictResolutionKey(
					project.repo,
					trigger.prNumber,
					trigger.headSha,
					trigger.baseSha,
				),
				PENDING_CONTINUATION_CLAIM_TTL_SEC,
			);
		}
	}

	// Persist the durable capacity wait *before* settling the visible run: the
	// dispatch row is the retry intent, so a crash after this line loses nothing.
	const pendingPayload = deriveCapacityPendingPayload(job, {
		phase: trigger.phase,
		runId: deferred.runId,
		resumable: false,
		continuationDispatchClaimed: deferred.continuationDispatchClaimed,
	});
	await persistRetryPayloadOnRun(deferred.runId, pendingPayload);
	await deferDispatchToPending(dispatch.id, {
		jobPayload: pendingPayload,
		waitReason: 'project-capacity',
		continuation: deferred.pendingContinuation === true,
		runId: deferred.runId,
	});

	// This pre-try/catch path must settle the visible run now. A slot deferral has
	// no scheduled timestamp: a release, not polling, wakes it.
	await finalizeFailedRun(deferred.runId, deferred, undefined);
	return deferred;
}

/**
 * Task IDs whose phase is currently running in *this* worker process, keyed by
 * the worktree task id a phase provisions (`task-<id>`, `src/worker/git-worktree-manager.ts`).
 *
 * A single drag of a board card fires two `projects_v2_item` webhooks
 * (`reordered` + `edited`), which arrive as two jobs. The Redis dedup
 * (`src/triggers/pm-status-dedup.ts`) collapses them only while its short TTL is
 * live; a duplicate that waits in the queue longer than that TTL — stuck behind
 * other multi-minute phase runs — re-passes the dedup once its key has expired
 * and re-dispatches the *same* phase for the *same* task while the first run is
 * still in flight. That second run's `provision()` then collides on the
 * existing `task-<id>` worktree and fails the (redundant) job with a hard
 * "worktree already exists" error, even though the original run completes fine.
 *
 * This in-process guard closes that window at the worktree's own granularity:
 * if a phase's worktree task id is already running here, the duplicate is
 * skipped as a no-op instead of dispatched into a collision. The check-and-add
 * is synchronous — no `await` between {@link Set.has} and {@link Set.add} — so
 * BullMQ concurrency can't interleave two callers past it. It intentionally does
 * *not* touch a stale worktree left by a previous crashed process (that's not in
 * this set); reclaiming those is issue #99's job, and surfacing the collision
 * they still cause is issue #98's. Single-worker MVP, so in-memory suffices; a
 * multi-worker deployment would need a Redis lease keyed the same way.
 */
const inFlightTaskIds = new Set<string>();

/**
 * Resolve the model for a phase, walking a four-tier fallback chain (most to
 * least specific):
 *
 *   per-phase model → project `agents.defaults[cli]` → global
 *   `agents.defaults[cli]` (`globalDefaults`, the DB-backed app settings,
 *   `src/config/app-settings.ts`) → coded `DEFAULT_MODEL_PER_CLI[cli]`.
 *
 * The per-phase CLI may itself be undefined (meaning the pipeline phase's own
 * coded default); when so, `'claude'` is used only to key the defaults maps and
 * the coded fallback — the *actual* phase CLI is resolved pipeline-side.
 */
function resolveModel(
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	phaseCli?: AgentCli,
	phaseModel?: string,
): string {
	if (phaseModel) return phaseModel;
	const cli = phaseCli ?? DEFAULT_ENGINE;
	return project.agents?.defaults?.[cli] ?? globalDefaults?.[cli] ?? DEFAULT_MODEL_PER_CLI[cli];
}

/**
 * Check whether Planning **completed** for this work item — a failed or
 * deferred attempt does not count (issue #247). The history lookup is
 * best-effort: an error assumes planning occurred so dispatch keeps using the
 * established Implementation config rather than changing behavior on a DB hiccup.
 */
async function wasPrecededByPlanning(projectId: string, taskId: string): Promise<boolean> {
	try {
		return await hasCompletedRunForTask(projectId, taskId, 'planning');
	} catch (err) {
		logger.error('Failed to check for a prior planning run (assuming planned)', {
			projectId,
			taskId,
			error: describeError(err),
		});
		return true;
	}
}

/**
 * Resolve the *explicitly requested* reasoning level for a phase — per-run
 * `reasoningOverride` → per-phase config, and nothing else. Unlike `model`,
 * reasoning has no per-CLI defaults tier: a default level valid for one model
 * can be invalid for another (issue #180). Omitting it here means the CLI keeps
 * its own default behavior (claude/codex get no reasoning flag; antigravity's
 * combined-variant string falls back to the model's default inside
 * `resolveModelLaunch`), which is what we persist as "Default (unknown)".
 *
 * A requested level is dropped (→ `undefined`) when the effective model doesn't
 * support it, so a stale override left over from a different model/CLI can't
 * launch an invalid variant — it degrades to the CLI/model default instead.
 */
function resolveReasoning(
	cli: AgentCli | undefined,
	model: string,
	phaseReasoning?: ReasoningLevel,
	overrideReasoning?: ReasoningLevel,
): ReasoningLevel | undefined {
	const requested = overrideReasoning ?? phaseReasoning;
	if (!requested) return undefined;
	if (!cli) return requested;
	const cap = capabilityFor(cli, model);
	if (!cap) return requested; // legacy/unknown model — trust the value
	return (cap.reasoningChoices as readonly ReasoningLevel[]).includes(requested)
		? requested
		: undefined;
}

/**
 * Make a phase's routing decision (issue #346) visible in the worker log: quiet
 * (debug) when the preferred target won, louder when this worker had to route
 * around a CLI it cannot run — the case an operator needs to see, since it
 * explains why a run used a model the project didn't ask for first.
 */
function logAgentRouting(
	project: ProjectConfig,
	trigger: TriggerResult,
	routing?: TargetSelection,
): void {
	if (!routing) return;
	const context = {
		projectId: project.id,
		phase: trigger.phase,
		taskId: trigger.taskId,
		// An undefined `cli` means the phase's own coded default (`DEFAULT_*_CLI`).
		cli: routing.target.cli ?? 'phase default',
		model: routing.target.model,
		targetIndex: routing.index,
	};
	if (routing.fallback) {
		logger.warn('No configured target CLI is available here - using the preferred target', context);
	} else if (routing.skipped.length > 0) {
		logger.info('Routed the phase to a lower-priority target', {
			...context,
			unavailable: routing.skipped,
		});
	} else {
		logger.debug('Routed the phase to its preferred target', context);
	}
}

/**
 * Run the pipeline phase a matched trigger resolved to. The orchestrators
 * differ in their inputs but all resolve to a result carrying the agent run
 * (`.agent`); the phase owns its own worktree lifecycle, so this doesn't
 * provision anything. `signal` (the worker's shutdown signal) is threaded
 * through so a graceful shutdown kills any in-flight agent CLI.
 *
 * `movedTo` (planning/implementation only) surfaces the canonical completion
 * status the phase moved the item to, if any — `processJob` uses it to
 * self-enqueue a next PM-driven phase (see {@link selfEnqueueNextPhase}) rather
 * than waiting on a webhook GitHub will never deliver for a SWARM persona's move.
 */
function runPhase(
	trigger: TriggerResult,
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	availableClis: WorkerCliAvailability,
	job: SwarmJob,
	runId: string | undefined,
	signal?: AbortSignal,
	implementationUnplanned = false,
): Promise<{
	agent: AgentCliResult;
	movedTo?: PmStatusKey;
	split?: { subTaskItemIds: string[]; mainTaskUpdated: boolean };
	/** The submitted verdict of a Review run — persisted onto its history row (issue #218). */
	verdict?: ReviewVerdict;
	/** This Review run's two-verdict safety-cap slot (1 or 2) — persisted onto its history row (issue #235). */
	reviewOrdinal?: number;
	/** This Review run's automation outcome (e.g. `manual-intervention-required`) — persisted onto its history row (issue #235). */
	automationOutcome?: ReviewAutomationOutcome;
}> {
	const overrides = agentOverrideFor(
		project,
		globalDefaults,
		availableClis,
		trigger.phase,
		job,
		implementationUnplanned,
	);
	logAgentRouting(project, trigger, overrides.routing);
	const runAgent = createLiveOutputRunner(runId);
	// Session threading, uniform across every phase (issue: cross-CLI resume). On a
	// resume retry (`resumeSession`) the persisted id is handed back as the CLI's
	// resume id; on a fresh run it's assigned as claude's `--session-id` (codex/agy
	// ignore the assign and have their id captured post-run).
	const session = {
		sessionId: job.resumeSession ? undefined : job.agentSessionId,
		resumeSessionId: job.resumeSession ? job.agentSessionId : undefined,
		resumeDelivery: job.resumeDelivery === true,
	};
	const markImplementationBranchProvisioned = async (): Promise<void> => {
		job.implementationBranchProvisioned = true;
		if (!runId) return;
		try {
			await updateRunJobPayload(runId, job);
		} catch (err) {
			logger.error('Failed to persist Implementation branch checkpoint', {
				runId,
				taskId: trigger.taskId,
				error: describeError(err),
			});
		}
	};
	switch (trigger.phase) {
		case 'planning':
			return runPlanningPhase({
				project,
				workItem: trigger.workItem,
				taskId: trigger.taskId,
				pm: createGitHubProjectsProvider(project),
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
				customPrompt: overrides.customPrompt,
				autoAdvance: project.pipeline?.planning?.autoAdvance,
				autoSplit: project.pipeline?.planning?.autoSplit,
				maxConcerns: project.pipeline?.planning?.maxConcerns,
				timeoutMs: overrides.timeoutMs,
				signal,
				...session,
				runAgent,
			});
		case 'implementation':
			return runImplementationPhase({
				project,
				workItem: trigger.workItem,
				taskId: trigger.taskId,
				pm: createGitHubProjectsProvider(project),
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
				customPrompt: overrides.customPrompt,
				resumeExistingBranch: job.implementationBranchProvisioned === true,
				onBranchProvisioned: markImplementationBranchProvisioned,
				...session,
				timeoutMs: overrides.timeoutMs,
				signal,
				runAgent,
			});
		case 'review':
			return runReviewPhase({
				project,
				prNumber: trigger.prNumber,
				headSha: trigger.headSha,
				taskId: trigger.taskId,
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
				customPrompt: overrides.customPrompt,
				...session,
				timeoutMs: overrides.timeoutMs,
				signal,
				runAgent,
			});
		case 'respond-to-review':
			return runRespondToReviewPhase({
				project,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				reviewId: trigger.reviewId,
				headSha: trigger.headSha,
				taskId: trigger.taskId,
				pm: createGitHubProjectsProvider(project),
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
				customPrompt: overrides.customPrompt,
				...session,
				timeoutMs: overrides.timeoutMs,
				signal,
				runAgent,
			});
		case 'respond-to-ci':
			return runRespondToCiPhase({
				project,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
				taskId: trigger.taskId,
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
				customPrompt: overrides.customPrompt,
				...session,
				timeoutMs: overrides.timeoutMs,
				signal,
				runAgent,
			});
		case 'resolve-conflicts':
			return runResolveConflictsPhase({
				project,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
				baseBranch: trigger.baseBranch,
				baseSha: trigger.baseSha,
				taskId: trigger.taskId,
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
				customPrompt: overrides.customPrompt,
				...session,
				timeoutMs: overrides.timeoutMs,
				signal,
				runAgent,
			});
	}
}

function createLiveOutputRunner(runId: string | undefined): typeof runAgentCli {
	if (!runId) {
		return runAgentCli;
	}
	return async (options) => {
		let pending = Promise.resolve();
		let queuedBytes = 0;
		let reachedOutputLimit = false;
		let timer: NodeJS.Timeout | undefined;
		let queue: Array<{ stream: 'stdout' | 'stderr'; content: string; emittedAt: Date }> = [];
		const flush = (): void => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			const batch = queue;
			queue = [];
			if (batch.length === 0) return;
			pending = pending
				.then(() => appendRunOutputEvents(runId, batch))
				.catch((err) =>
					logger.error('Failed to persist live run output (continuing)', {
						runId,
						error: describeError(err),
					}),
				);
		};
		const append = (stream: 'stdout' | 'stderr', line: string): void => {
			if (reachedOutputLimit) return;
			const content = `${line}\n`;
			queuedBytes += Buffer.byteLength(content);
			queue.push({ stream, content, emittedAt: new Date() });
			// Keep the boundary event: the repository clips it and records that
			// retention was truncated. Dropping it here leaves the UI unaware.
			if (queuedBytes > MAX_RUN_OUTPUT_BYTES) {
				reachedOutputLimit = true;
				flush();
				return;
			}
			if (queue.length >= 100) flush();
			else timer ??= setTimeout(flush, 100);
		};
		const result = await runAgentCli({
			...options,
			onStdout: (line) => {
				options.onStdout?.(line);
				append('stdout', line);
			},
			onStderr: (line) => {
				options.onStderr?.(line);
				append('stderr', line);
			},
		});
		flush();
		await pending;
		return result;
	};
}

/**
 * The per-phase agent override (`cli`/`model`) a project configured, resolving
 * `runPhase`'s own `project.agents?.<phase>?.{cli,model}` lookup once so a run
 * row can record the *requested* model at creation without threading it through
 * `runPhase`'s signature. `model` may be undefined — "the phase's coded default
 * is in effect", the same convention `describeAgent` uses.
 *
 * `engine` is the resolved effective CLI (`cli` with the coded {@link
 * DEFAULT_ENGINE} applied), persisted on the run row at creation/reset so the
 * dashboard shows it while a run is still `running` (issue #169); `cli` stays
 * undefined-preserving because the phase orchestrators expect that (they apply
 * their own `DEFAULT_*_CLI`). Finalization still records what actually ran
 * (`AgentCliResult.cli`), confirming or correcting the persisted engine.
 *
 * The model is resolved through the same fallback chain `runPhase` uses
 * (per-phase → project default → global default → coded default), so the
 * recorded value matches what actually runs.
 *
 * Which of the phase's `targets` is resolved depends on `availableClis` — the
 * CLIs this worker can actually run (issue #346). See {@link selectTarget}.
 */
function agentOverrideFor(
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	availableClis: WorkerCliAvailability,
	phase: TriggerPhase,
	job?: SwarmJob,
	implementationUnplanned = false,
): {
	cli?: AgentCli;
	engine: AgentCli;
	model?: string;
	reasoning?: ReasoningLevel;
	timeoutMs?: number;
	customPrompt?: string;
	/** The routing decision behind `cli`, when the phase configured targets. */
	routing?: TargetSelection;
} {
	const phaseConfig = (() => {
		switch (phase) {
			case 'planning':
				return project.agents?.planning ?? {};
			case 'implementation':
				return implementationUnplanned
					? (project.agents?.implementationUnplanned ?? project.agents?.implementation ?? {})
					: (project.agents?.implementation ?? {});
			case 'review':
				return project.agents?.review ?? {};
			case 'respond-to-review':
				return project.agents?.respondToReview ?? {};
			case 'respond-to-ci':
				return project.agents?.respondToCi ?? {};
			case 'resolve-conflicts':
				return project.agents?.resolveConflicts ?? {};
		}
	})();
	const overrideReasoning = isReasoningLevel(job?.reasoningOverride)
		? job?.reasoningOverride
		: undefined;
	// A per-run override pins one exact selection (a manual "retry with this
	// CLI/model" — `src/api/routers/runs.ts`), so it wins over routing: the run
	// resolves against the phase's own configured selection, as it did before.
	const pinned = Boolean(job?.cliOverride ?? job?.modelOverride ?? overrideReasoning);
	const routing = pinned ? undefined : selectTarget(phaseConfig.targets, availableClis);
	// The phase-level `cli`/`model`/`reasoning` mirror `targets[0]`, so they are the
	// right source whenever routing selected nothing (no list configured, or a
	// pinned run) — including a config that predates the list entirely.
	const target = routing?.target ?? phaseConfig;
	const cli = job?.cliOverride ?? target.cli;
	const model = job?.modelOverride ?? resolveModel(project, globalDefaults, cli, target.model);
	const reasoning = resolveReasoning(cli, model, target.reasoning, overrideReasoning);
	// Fall back to the worker's default wall-clock timeout when the project set no
	// per-phase override, so *every* agent invocation is bounded (issue #165).
	return {
		cli,
		engine: cli ?? DEFAULT_ENGINE,
		model,
		reasoning,
		routing,
		timeoutMs: phaseConfig.timeoutMs ?? AGENT_TIMEOUT_MS,
		// The project's optional per-phase custom prompt (issue #135). No default —
		// absent means the phase composes exactly its static prompt.
		customPrompt: phaseConfig.prompt,
	};
}

/**
 * Best-effort load of the global per-CLI default models (`agents.defaults` in
 * the DB-backed app settings, `src/config/app-settings.ts`) — the tier
 * `resolveModel` walks between a project's own defaults and the coded defaults.
 * A DB hiccup here must never fail a real pipeline run, so this swallows+logs
 * any error and returns `undefined` (fall through to the coded defaults),
 * consistent with the "run tracking is best-effort" contract in this file.
 */
async function loadGlobalDefaults(): Promise<AgentDefaults | undefined> {
	try {
		return (await getAppSettings()).agents?.defaults;
	} catch (err) {
		logger.error('Failed to load global agent defaults (using coded defaults)', {
			error: describeError(err),
		});
		return undefined;
	}
}

async function tryReuseLatestRun(
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	availableClis: WorkerCliAvailability,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const prior = await getLatestRunForTask(project.id, trigger.taskId, trigger.phase);
	if (!prior || (prior.status !== 'deferred' && prior.status !== 'failed')) return undefined;
	if (job.resumeSession && prior.agentSessionId) {
		job.agentSessionId = prior.agentSessionId;
	} else if (!job.resumeSession) {
		delete job.agentSessionId;
	}
	const overrides = agentOverrideFor(
		project,
		globalDefaults,
		availableClis,
		trigger.phase,
		job,
		implementationUnplanned,
	);
	const recoveryVal = job.recoveryMode
		? { state: 'recovered' as const, agentSessionId: job.agentSessionId ?? null }
		: null;
	const claimed = await resetRunToRunning(
		prior.id,
		{ ...job, runId: prior.id },
		prior.status,
		overrides.model,
		overrides.timeoutMs,
		overrides.reasoning ?? null,
		overrides.engine,
		job.resumeSession ? undefined : null,
		recoveryVal,
	);
	if (!claimed) return undefined;
	job.runId = prior.id;
	return prior.id;
}

async function tryResetCarriedRun(
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	availableClis: WorkerCliAvailability,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const runId = job.runId;
	if (!runId) return undefined;
	try {
		const overrides = agentOverrideFor(
			project,
			globalDefaults,
			availableClis,
			trigger.phase,
			job,
			implementationUnplanned,
		);
		const recoveryVal = job.recoveryMode
			? { state: 'recovered' as const, agentSessionId: job.agentSessionId ?? null }
			: null;
		return (await resetRunToRunning(
			runId,
			job,
			undefined,
			overrides.model,
			overrides.timeoutMs,
			overrides.reasoning ?? null,
			overrides.engine,
			job.resumeSession ? undefined : null,
			recoveryVal,
		))
			? runId
			: undefined;
	} catch (err) {
		logger.error('Failed to reset run row for retry (creating a new one)', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			runId,
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * Best-effort creation of a run-history row before a phase runs. Run tracking is
 * a secondary, single-dev dashboard view (issue #102); a DB hiccup here must
 * never fail an actual pipeline run, so this swallows and logs any error and
 * returns `undefined` — the completion path then no-ops for a run with no id.
 *
 * When the job carries an `existingRunId` (a re-enqueued deferred run, or a
 * manual "Retry now" — issue #136), the originating row is *reset* to `running`
 * and reused rather than inserting a second one, so a retry shows as one run on
 * the dashboard, not two. If that row no longer exists (pruned between the
 * deferral and the retry), this falls through to creating a fresh row.
 */
/**
 * Best-effort PR title for a PR-driven run's history row (review / respond-to-*),
 * so the dashboard shows the human-readable title instead of the synthetic
 * `<pr>-respond` taskId. Swallows+logs any error and returns `undefined` — a
 * failed title lookup (transient API blip, missing token) must never fail the
 * run, consistent with the "run tracking is best-effort" contract in this file.
 */
async function tryFetchPrTitle(
	project: ProjectConfig,
	prNumber: string,
): Promise<string | undefined> {
	try {
		const title = await new GitHubSCMIntegration().getPullRequestTitle(project, Number(prNumber));
		return title ?? undefined;
	} catch (err) {
		logger.debug('Failed to fetch PR title for run row (continuing without it)', {
			projectId: project.id,
			prNumber,
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * Reuse an existing `runs` row for this job rather than inserting a new one:
 * the carried row when the job names one (a re-enqueued deferral or manual
 * retry — issue #136), otherwise the latest terminal row for the task. Returns
 * the reused row's id, or `undefined` when there's nothing to reuse (the caller
 * then creates a fresh row). Restores a resumable Claude session id from the
 * carried row onto the job before resetting it, so a resumed retry threads the
 * session through to the phase.
 */
async function reuseRunRow(
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	availableClis: WorkerCliAvailability,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const existingRunId = job.runId;
	if (existingRunId) {
		try {
			const existing = await getRunByIdFromDb(existingRunId);
			if (existing?.agentSessionId) job.agentSessionId = existing.agentSessionId;
		} catch (err) {
			logger.debug('Failed to load resumable agent session (retrying from scratch)', {
				runId: existingRunId,
				error: describeError(err),
			});
		}
		return tryResetCarriedRun(
			project,
			globalDefaults,
			availableClis,
			trigger,
			job,
			implementationUnplanned,
		);
	}
	try {
		return await tryReuseLatestRun(
			project,
			globalDefaults,
			availableClis,
			trigger,
			job,
			implementationUnplanned,
		);
	} catch (err) {
		logger.error('Failed to reuse terminal run row (creating a new one)', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: describeError(err),
		});
		return undefined;
	}
}

async function tryCreateRun(
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	availableClis: WorkerCliAvailability,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const reusedRunId = await reuseRunRow(
		project,
		globalDefaults,
		availableClis,
		trigger,
		job,
		implementationUnplanned,
	);
	if (reusedRunId) return reusedRunId;
	const prNumber = 'prNumber' in trigger ? trigger.prNumber : undefined;
	try {
		const overrides = agentOverrideFor(
			project,
			globalDefaults,
			availableClis,
			trigger.phase,
			job,
			implementationUnplanned,
		);
		const runId = await createRun({
			projectId: project.id,
			taskId: trigger.taskId,
			phase: trigger.phase,
			workItemId: 'workItem' in trigger ? trigger.workItem.id : undefined,
			workItemTitle: 'workItem' in trigger ? trigger.workItem.title : undefined,
			workItemUrl: 'workItem' in trigger && trigger.workItem.url ? trigger.workItem.url : undefined,
			prNumber,
			prTitle: prNumber ? await tryFetchPrTitle(project, prNumber) : undefined,
			engine: overrides.engine,
			model: overrides.model,
			reasoning: overrides.reasoning,
			timeoutMs: overrides.timeoutMs,
			jobPayload: job,
		});
		job.agentSessionId = runId;
		return runId;
	} catch (err) {
		logger.error('Failed to create run row (continuing)', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * Best-effort finalization of a run-history row: set its terminal columns and,
 * when the run produced captured output, store its stdout/stderr. No-ops when
 * `runId` is undefined (creation failed) and swallows+logs any DB error, so the
 * two completion sites (success/failure) don't each repeat the try/catch and a
 * DB hiccup can't turn a settled pipeline run into a failed job (issue #102).
 */
async function finalizeRun(
	runId: string | undefined,
	input: CompleteRunInput,
	agent?: AgentCliResult,
): Promise<void> {
	if (!runId) return;
	try {
		await completeRun(runId, input);
		if (agent) await storeRunLogs(runId, agent.stdout, agent.stderr);
	} catch (err) {
		logger.error('Failed to finalize run row (continuing)', {
			runId,
			error: describeError(err),
		});
	}
}

/**
 * Finalize a run row for a failed/deferred outcome. A `phase-deferred` outcome
 * records `deferred` (the run will retry — not an error); anything else records
 * `failed`. When the failure carried its agent result ({@link AgentRunError.agent}),
 * its engine/exit/timing columns and captured logs are persisted too; a failure
 * that never ran an agent (missing hand-off file, worktree setup) records the
 * `error` message only.
 */
async function finalizeFailedRun(
	runId: string | undefined,
	outcome: JobOutcome,
	err: unknown,
): Promise<void> {
	const agent = err instanceof AgentRunError ? err.agent : undefined;
	if (outcome.status === 'phase-deferred') {
		await finalizeRun(
			runId,
			{
				status: 'deferred',
				error: outcome.reason,
				nextRetryAt: outcome.pendingDispatch ? null : new Date(Date.now() + outcome.retryDelayMs),
				...agentColumns(agent),
				// Persist the session id the run captured so the retry can resume it —
				// for claude the id it assigned/echoed, for codex/agy the id captured
				// from their output/store. `null` when not resumable, or when the run
				// created no session to resume (retry then starts from scratch).
				agentSessionId: outcome.resumable ? (agent?.sessionId ?? null) : null,
			},
			agent,
		);
	} else if (outcome.status === 'phase-failed') {
		let recoveryVal: any = null;
		let sessionToRetain: string | null = null;
		// The recorded cancellation origin (issue #308), when this failure is a
		// cancellation: the object when the supported dashboard/API `terminate`
		// action recorded one, `null` for a marker-only (external/unknown)
		// cancellation, `undefined` when this failure isn't a cancellation at all
		// (leaves the column untouched — see `CompleteRunInput.cancellation`).
		let cancellationOrigin: CancellationOrigin | null | undefined;

		if (err instanceof BlockedRecoveryError) {
			recoveryVal = {
				state: 'blocked',
				blockedReason: err.reason,
			};
		} else {
			const isCancelled = runId ? await isRunCancellationRequested(runId) : false;
			if (isCancelled && runId) {
				cancellationOrigin = await getRunCancellationOrigin(runId);
				const run = await getRunByIdFromDb(runId);
				const activeSessionId = agent?.sessionId ?? run?.agentSessionId;
				if (activeSessionId) {
					sessionToRetain = activeSessionId;
					recoveryVal = {
						state: 'preserved',
						agentSessionId: activeSessionId,
					};
				}
			}
		}

		await finalizeRun(
			runId,
			{
				status: 'failed',
				error: outcome.error,
				agentSessionId: sessionToRetain,
				recovery: recoveryVal,
				cancellation: cancellationOrigin,
				...agentColumns(agent),
			},
			agent,
		);
	}
}

/** The run's engine/exit/timing columns, pulled from a captured agent result. */
function agentColumns(agent: AgentCliResult | undefined): Partial<CompleteRunInput> {
	return {
		engine: agent?.cli,
		exitCode: agent?.exitCode,
		timedOut: agent?.timedOut,
		durationMs: agent?.durationMs,
		usage: agent?.usage,
	};
}

/**
 * After a PM-driven phase's own `autoAdvance` moves the item to a status that
 * starts the *next* phase (currently only Planning → "ToDo" → Implementation,
 * `src/pm/pipeline.ts`), self-enqueue a synthetic board-status job for it
 * instead of waiting on GitHub's webhook echo of that move.
 *
 * The router's loop-prevention gate (`GitHubProjectsRouterAdapter.isSelfAuthored`)
 * drops *every* Projects status-change webhook authored by a SWARM persona —
 * correctly, since that's exactly the feedback loop it exists to break. But
 * Planning moves its own card using the `implementer` persona
 * (`src/integrations/scm/github/personas.ts`), the very identity that move's
 * webhook gets checked against — so the direct webhook for this transition is
 * dropped every time, and the pipeline previously advanced only when some
 * other, differently-attributed webhook for the same item happened to arrive
 * later (an unbounded wait — confirmed live: an item sat in "ToDo" for hours
 * with Implementation never dispatching). This bypasses the router and webhook
 * entirely — a manual/synthetic job with no `deliveryId`, exactly the
 * `enqueueJob` carve-out already documented in `src/queue/producer.ts` — and
 * drives it through the *same* trigger-match → authoritative-re-read → dedup
 * path a real webhook would, so "which phase does this status start" is
 * resolved in exactly one place.
 *
 * Best-effort: a failure to self-enqueue is logged, not thrown, so it can't
 * turn an already-succeeded phase into a failed job — worst case the item is
 * left exactly where the phase left it, same as before this existed.
 */
async function selfEnqueueNextPhase(
	project: ProjectConfig,
	workItem: WorkItem,
	movedTo: PmStatusKey | undefined,
): Promise<void> {
	if (!movedTo) return;
	const nextPhase = resolvePipelinePhaseForStatusKey(movedTo);
	if (!nextPhase) return;

	try {
		const job: SwarmJob = {
			type: 'github-projects',
			projectId: project.id,
			event: {
				eventType: 'projects_v2_item',
				action: 'edited',
				itemNodeId: workItem.id,
				projectNodeId: project.githubProjects.projectId,
				changedFieldNodeId: project.githubProjects.statusFieldId,
				changedFieldType: 'single_select',
			},
		};
		await createAndPublishDispatch({
			projectId: project.id,
			jobPayload: job,
			priority: priorityFor(job) ?? 0,
			source: 'synthetic',
		});
		logger.debug('pm-status: self-enqueued next phase after auto-advance', {
			projectId: project.id,
			itemNodeId: workItem.id,
			movedTo,
			nextPhase,
		});
	} catch (err) {
		logger.error('Failed to self-enqueue next phase after auto-advance', {
			projectId: project.id,
			itemNodeId: workItem.id,
			movedTo,
			nextPhase,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Persist a durable merge dispatch after an eligible Review approval (issue
 * #292). The eligibility gate lives here, at the composition root, so pipeline
 * code neither merges nor schedules queue work (`ai/RULES.md` §2): only a
 * completed Review run's submitted `approve` verdict with
 * `pipeline.respondToReview.autoMerge` on requests a merge — the sole
 * eligibility rule (issue #235); Respond-to-review's own outcomes never do.
 * Execution happens later, when the dispatch's wake-up is claimed
 * (`processMergeAutomationDispatch`), never inline in the Review job.
 */
async function requestMergeAutomationIfEligible(
	trigger: TriggerResult,
	project: ProjectConfig,
	runId: string | undefined,
	verdict: ReviewVerdict | undefined,
): Promise<void> {
	if (trigger.phase !== 'review') return;
	if (verdict !== 'approve') return;
	if (project.pipeline?.respondToReview?.autoMerge !== true) return;
	if (!runId) {
		// The dispatch's dedup identity and outcome persistence both key on the
		// Review run row; without one (a degraded `tryCreateRun`) there is no safe
		// way to carry the intent — surface the miss instead of merging blindly.
		logger.warn('Review approval eligible for merge automation, but no run row exists — skipping', {
			projectId: project.id,
			prNumber: trigger.prNumber,
			headSha: trigger.headSha,
		});
		return;
	}
	await requestMergeAutomation({
		project,
		reviewRunId: runId,
		taskId: trigger.taskId,
		prNumber: trigger.prNumber,
		approvedHeadSha: trigger.headSha,
	});
}

/**
 * The comment SWARM posts on a work item's backing Issue when its phase fails
 * terminally. It names the phase and carries the failure message so a human
 * watching the board sees *why* the item stalled without digging through worker
 * logs — a failed phase leaves the item where it is (typically "In progress"),
 * so until now the failure had no board-visible signal at all.
 */
export function phaseFailureCommentBody(
	phase: TriggerPhase,
	error: string,
	kind?: AgentFailureKind,
): string {
	const lines = [
		'## ⚠️ SWARM run failed',
		'',
		`The **${phase}** phase did not complete — no result was produced.`,
		'',
		'```',
		error,
		'```',
		'',
		"This item hasn't moved. Re-trigger the phase once the cause is addressed; the agent's full output is in the worker logs.",
	];
	if (kind === 'stalled' || kind === 'timeout') {
		lines.push(
			'',
			// TODO(#104): once Splitting column exists, swap to:
			// 'This failure pattern (the agent gave up waiting for a model response) can mean the task’s scope was too large for a single run. Consider moving this item to **Splitting** (#104) to break it into smaller pieces, then re-triggering.'
			'This failure pattern (the agent gave up waiting for a model response) can mean the task’s scope was too large for a single run. Consider splitting the issue by hand into smaller pieces, then re-triggering.',
		);
	}
	if (kind === 'capacity') {
		lines.push(
			'',
			'The selected model was reported **at capacity** by the provider (not a usage/quota limit). Configure a different model for this phase or project (see the Configuration section of the README) and re-trigger.',
		);
	}
	lines.push('', '---', '_Generated by SWARM._');
	return lines.join('\n');
}

/**
 * Post a phase-failure comment on the backing Issue of a work-item-carrying
 * phase (planning/implementation) or on the backing PR of a PR-driven phase
 * (review/respond-*). Best-effort: a failed comment is swallowed and logged so
 * it can't mask the phase failure it's reporting (the same swallow-and-log
 * contract the phases use for worktree cleanup).
 */
async function reportPhaseFailureToBoardOrPr(
	trigger: TriggerResult,
	project: ProjectConfig,
	error: string,
	kind?: AgentFailureKind,
): Promise<void> {
	try {
		const body = phaseFailureCommentBody(trigger.phase, error, kind);
		if ('workItem' in trigger) {
			const pm = createGitHubProjectsProvider(project);
			const commentId = await pm.addComment(trigger.workItem.id, body);
			logger.debug('Posted phase-failure comment to the board item', {
				projectId: project.id,
				phase: trigger.phase,
				taskId: trigger.taskId,
				workItemId: trigger.workItem.id,
				commentId,
			});
		} else if ('prNumber' in trigger) {
			const scm = new GitHubSCMIntegration();
			const commentId = await scm.commentOnPullRequest(project, Number(trigger.prNumber), body);
			logger.debug('Posted phase-failure comment to the PR', {
				projectId: project.id,
				phase: trigger.phase,
				taskId: trigger.taskId,
				prNumber: trigger.prNumber,
				commentId,
			});
		}
	} catch (commentErr) {
		logger.error('Failed to post phase-failure comment', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: commentErr instanceof Error ? commentErr.message : String(commentErr),
		});
	}
}

/**
 * The comment SWARM posts when a job is killed by the queue itself — a *stalled*
 * job (BullMQ reclaimed it because the worker couldn't renew its lock in time)
 * rather than a phase that ran and failed. Unlike {@link phaseFailureCommentBody}
 * this can't name the phase's own error (there isn't one — the queue gave up on
 * the job), so it explains the interruption and carries the queue's message.
 *
 * Crucially it does *not* claim the run produced nothing: a stall is the queue
 * abandoning the job, not the phase's process dying, so the orphaned agent run
 * often keeps going and posts its result *after* the queue reclaimed the job —
 * observed live: a Review job reclaimed as stalled still submitted its approval
 * ~2.5 min later. So the wording covers both outcomes (recovered vs genuinely
 * lost) rather than telling a human to re-trigger a phase that already finished.
 */
export function interruptedRunCommentBody(error: string): string {
	return [
		'## ⚠️ SWARM run interrupted',
		'',
		'A SWARM run for this item was reclaimed by the queue as *stalled* — the worker ' +
			'could not renew the job’s lock in time (an overloaded, restarted, or crashed worker).',
		'',
		'```',
		error,
		'```',
		'',
		'The run may have finished anyway after the queue gave up: if a result already ' +
			'appeared for it (a review, a plan, a PR comment, a moved card), it recovered and no ' +
			'action is needed. If nothing appeared, re-trigger the phase once the worker is healthy ' +
			'(move the card, re-open/push the PR, or re-run its checks).',
		'',
		'---',
		'_Generated by SWARM._',
	].join('\n');
}

/**
 * Leave a board-visible trace when a job is failed by the queue *outside*
 * `processJob` — a stalled job (lock lost → reclaimed; `maxStalledCount: 0` fails
 * it terminally with no retry). Those never reach {@link handlePhaseFailure}, so
 * without this the run vanishes into the worker log with nothing on the board.
 * Called from the entrypoint's `failed` handler with the raw job data.
 *
 * Best-effort and fully self-contained: it re-validates the (Redis-round-tripped)
 * job data, resolves the project itself, and swallows every error — a failure to
 * comment must not throw out of an event handler. The target is derived straight
 * from the job's event (no trigger re-dispatch, which would re-run dedup claims
 * and API calls): a board event → the work item (Issue) via the PM provider; a
 * PR/check event → the PR via the SCM integration (the PM provider has no
 * PR-number → comment mapping, mirroring {@link reportPhaseFailureToBoard}).
 */
export async function reportInterruptedJobToBoard(jobData: unknown, error: string): Promise<void> {
	let job: SwarmJob;
	try {
		job = SwarmJobSchema.parse(jobData);
	} catch (parseErr) {
		logger.warn('Interrupted-job report: job data did not validate — skipping comment', {
			error: parseErr instanceof Error ? parseErr.message : String(parseErr),
		});
		return;
	}

	try {
		const project = await findProjectByIdFromDb(job.projectId);
		if (!project) {
			// Unknown project (deleted mid-flight, or the non-stall `processJob` throw
			// that also lands here) — nothing to comment on.
			logger.debug('Interrupted-job report: project not found — skipping comment', {
				projectId: job.projectId,
			});
			return;
		}

		// A merge-automation dispatch has no board item and posts nothing — its
		// outcome is already visible on the Review run and the dispatch record.
		if (job.type === 'merge-automation') {
			logger.debug('Interrupted-job report: merge-automation dispatch — skipping comment', {
				projectId: job.projectId,
				prNumber: job.prNumber,
			});
			return;
		}

		const body = interruptedRunCommentBody(error);

		if (job.type === 'github-projects') {
			const pm = createGitHubProjectsProvider(project);
			const commentId = await pm.addComment(job.event.itemNodeId, body);
			logger.info('Posted interrupted-run comment on board item', {
				projectId: project.id,
				itemNodeId: job.event.itemNodeId,
				commentId,
			});
			return;
		}

		const prNumber = job.event.workItemId;
		if (!prNumber) {
			logger.debug('Interrupted-job report: github job carries no PR/issue number — skipping', {
				projectId: project.id,
				eventType: job.event.eventType,
			});
			return;
		}
		const scm = new GitHubSCMIntegration();
		const commentId = await scm.commentOnPullRequest(project, Number(prNumber), body);
		logger.info('Posted interrupted-run comment on PR', {
			projectId: project.id,
			prNumber,
			commentId,
		});
	} catch (commentErr) {
		logger.error('Failed to post interrupted-run comment', {
			projectId: job.projectId,
			error: commentErr instanceof Error ? commentErr.message : String(commentErr),
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
function buildTriggerContext(
	job: GitHubWebhookJob | GitHubProjectsWebhookJob,
	project: ProjectConfig,
): TriggerContext {
	return job.type === 'github'
		? {
				project,
				deliveryId: job.deliveryId,
				recheckAttempt: job.recheckAttempt,
				rateLimitRetryAttempt: job.rateLimitRetryAttempt,
				runId: job.runId,
				continuationDispatchClaimed: job.continuationDispatchClaimed,
				source: 'github',
				event: job.event,
			}
		: {
				project,
				deliveryId: job.deliveryId,
				recheckAttempt: job.recheckAttempt,
				rateLimitRetryAttempt: job.rateLimitRetryAttempt,
				runId: job.runId,
				continuationDispatchClaimed: job.continuationDispatchClaimed,
				resumePmPhase: job.resumePmPhase,
				source: 'github-projects',
				event: job.event,
			};
}

async function handlePhaseFailure(
	err: unknown,
	job: SwarmJob,
	trigger: TriggerResult,
	project: ProjectConfig,
	runId: string | undefined,
): Promise<JobOutcome> {
	// Delivery errors deliberately wrap a resumable checkpoint around the
	// underlying push/hook/API failure. Preserve that cause chain in the run row,
	// dashboard, and logs instead of reducing every incident to the opaque
	// "delivery deferred" wrapper.
	const error = describeError(err);

	// If the failure looks like a missing binary, permission issue, or authentication/login failure,
	// run capability discovery immediately to refresh the dashboard status.
	const isLaunchOrAuthFailure =
		error.includes('Failed to launch') ||
		error.includes('ENOENT') ||
		error.includes('permission denied') ||
		error.includes('not found') ||
		error.includes('authenticated') ||
		error.includes('login') ||
		error.includes('auth') ||
		(err instanceof AgentRunError && err.failure.kind === 'error');

	if (isLaunchOrAuthFailure) {
		void discoverCliQuotas()
			.then(async (snapshots) => {
				for (const snapshot of snapshots) {
					await upsertCliQuota(snapshot.cli, snapshot.status, snapshot);
				}
			})
			.catch((discoverErr) => {
				logger.error('Failed to run recovery quota discovery after launch failure', {
					error: String(discoverErr),
				});
			});
	}

	// A user asked to terminate this run (issue #166): its abort must settle as a
	// terminal, user-initiated failure — never a deferral, which would re-enqueue
	// the very run the user just killed. Checked before the deferrable-abort branch
	// below, since a user-termination abort is classified `aborted` and would
	// otherwise be deferred. The captured agent output is still persisted by
	// `finalizeFailedRun` (logs preserved); we only skip the board "failed" comment,
	// as an intentional stop isn't a stall a human needs to investigate.
	if (runId && (await isRunCancellationRequested(runId))) {
		logger.info(`Phase cancelled after cancellation request - ${phaseLabel(trigger.phase)}`, {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			runId,
		});
		return {
			status: 'phase-failed',
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: RUN_CANCELLED_MESSAGE,
			cancelled: true,
		};
	}

	// A dependency block (issue #330) is neither a failure nor a rate-limit: the
	// work item is `blocked by` an unfinished prerequisite. Defer as a token-free
	// `recheck` on its own budget while the budget lasts; once exhausted, fall
	// through to the terminal path below, which posts this "must be done first"
	// message on the item. Placed after the cancellation check so a user can still
	// cancel a run that is merely waiting on a dependency.
	if (err instanceof DependencyBlockedError) {
		const deferred = deferDependencyBlock(err, job, trigger, project.id, error, runId);
		if (deferred) return deferred;
	}

	const failureKind =
		err instanceof AgentRunError
			? err.failure.kind
			: err instanceof WorktreeAlreadyExistsError
				? 'worktree-exists'
				: err instanceof BlockedRecoveryError
					? 'blocked-recovery'
					: undefined;

	// A usage/session-limit hit, a worker-shutdown abort, or a worktree "already
	// exists" directory collision is transient/recoverable: rather than failing the
	// job, we defer it and let the worker re-enqueue it once it's safe to retry.
	// Capped so a persistent limit or collision can't loop forever.
	const isDeferrable =
		(err instanceof AgentRunError &&
			(err.failure.kind === 'rate-limit' ||
				err.failure.kind === 'capacity' ||
				err.failure.kind === 'aborted' ||
				err.failure.kind === 'stalled' ||
				// A timeout resumes only when the run was genuinely interrupted: it
				// carries an agent result whose exit was non-zero/null (the phase threw
				// and preserved its worktree). A run that trapped SIGTERM and still
				// exited 0 (issue #165's clean-exit case) already finished and cleaned up
				// its worktree, so it stays a terminal failure rather than deferring onto
				// a checkout that's gone.
				(err.failure.kind === 'timeout' && err.agent !== undefined && err.agent.exitCode !== 0))) ||
		err instanceof WorktreeAlreadyExistsError ||
		err instanceof DeliveryDeferredError;
	if (isDeferrable) {
		const failure: DeferrableFailure =
			err instanceof AgentRunError
				? err.failure
				: err instanceof DeliveryDeferredError
					? { kind: 'delivery' }
					: { kind: 'worktree-exists' };
		const deferred = deferAgentRunError(failure, job, trigger, project.id, error, runId);
		if (deferred) return deferred;
	}

	logger.error(`Phase failed - ${phaseLabel(trigger.phase)}`, {
		projectId: project.id,
		phase: trigger.phase,
		taskId: trigger.taskId,
		error,
	});
	// Report the terminal failure on the backing Issue or PR so a human sees why
	// the item stalled. Reached only for non-deferrable failures (the deferral
	// above returns early), so a run that's about to be retried never posts a
	// premature "failed".
	await reportPhaseFailureToBoardOrPr(trigger, project, error, failureKind);
	// The review handler's claim intentionally survives a failed run: the review
	// agent submits its formal `gh pr review` *inside* the run, so a phase that
	// threw afterward may have already posted the review — releasing the claim
	// here would let a sibling event for the same PR+SHA post a duplicate, the
	// exact incident the dedup guards against. The 5-minute TTL reaps a claim
	// whose run genuinely failed before submitting. See review-dispatch-dedup.ts.
	return { status: 'phase-failed', phase: trigger.phase, taskId: trigger.taskId, error };
}

export async function processJob(
	job: SwarmJob,
	registry: TriggerRegistry,
	signal?: AbortSignal,
): Promise<JobOutcome> {
	// Claim the durable dispatch behind this wake-up before acting on anything
	// (issue #284): a cancelled/completed/superseded dispatch refuses the claim,
	// so no delivery path — redelivery, delayed retry, slot release,
	// reconciliation — can resurrect terminal work. Legacy dispatch-less jobs
	// are adopted into the model here.
	const claim = await claimDispatchForJob(job, DISPATCH_CLAIM_LEASE_MS);
	if (!claim.claimed) {
		logger.info('Dispatch wake-up refused — dropping delivery', {
			projectId: job.projectId,
			dispatchId: job.dispatchId,
			reason: claim.reason,
		});
		return { status: 'dispatch-refused', reason: claim.reason };
	}
	const dispatch = claim.dispatch;
	try {
		// The dispatch row's stored payload is authoritative — a manual retry's
		// overrides land there, not on the wake-up job.
		job = parseDispatchPayload(dispatch);
	} catch (err) {
		const error = `Dispatch payload failed validation: ${describeError(err)}`;
		await tryFailDispatch(dispatch.id, error);
		logger.error('Dispatch payload failed validation — failing dispatch', {
			dispatchId: dispatch.id,
			error,
		});
		return { status: 'dispatch-refused', reason: 'invalid-payload' };
	}

	const project = await findProjectByIdFromDb(job.projectId);
	if (!project) {
		// The producer only enqueues for projects it resolved from Postgres, so a
		// miss here means the project was deleted mid-flight — fail loudly.
		await tryFailDispatch(dispatch.id, `Job references unknown project '${job.projectId}'`);
		throw new Error(`Job references unknown project '${job.projectId}'`);
	}

	// The agent-less dispatch kind (issue #292): a merge-automation dispatch
	// carries no webhook event, resolves no trigger, provisions no worktree, and
	// takes no project slot — it settles itself (complete / fail / bounded
	// retry-scheduled) against the claimed dispatch record.
	if (job.type === 'merge-automation') {
		return processMergeAutomationDispatch(dispatch, job, project);
	}

	const ctx = buildTriggerContext(job, project);

	const trigger = await registry.dispatch(ctx);
	if (!trigger) {
		logger.debug('Job matched no trigger — completing as a no-op', {
			projectId: project.id,
			source: ctx.source,
			eventType: job.event.eventType,
			deliveryId: job.deliveryId,
		});
		if (job.runId) {
			await finalizeRun(job.runId, {
				status: 'failed',
				error:
					'The pending continuation re-evaluated to no-trigger (e.g. disposition changed or was disabled)',
			});
			if (job.type === 'github' && job.event.workItemId && job.event.headSha) {
				const dispatchKey = buildReviewDispatchKey(
					project.repo,
					job.event.workItemId,
					job.event.headSha,
				);
				await releaseReviewDispatch(dispatchKey);
			}
		}
		await tryCompleteDispatch(dispatch.id, 'no-trigger');
		return { status: 'no-trigger' };
	}

	// Record the resolved task/phase on the dispatch so the Queue UI can name
	// what a waiting dispatch will run, even before a run row exists.
	try {
		await recordDispatchResolution(dispatch.id, trigger.taskId, trigger.phase);
	} catch (err) {
		logger.debug('Failed to record dispatch resolution (continuing)', {
			dispatchId: dispatch.id,
			error: describeError(err),
		});
	}

	// A duplicate webhook (or a delayed retry) that resolved to a phase whose
	// worktree task is already running here would collide on `task-<id>`; skip it
	// rather than dispatch into that collision. See `inFlightTaskIds`.
	if (inFlightTaskIds.has(trigger.taskId)) {
		logger.debug('Skipping phase — its worktree task is already running in this worker', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
		});
		await tryCompleteDispatch(dispatch.id, 'skipped-duplicate');
		return { status: 'skipped-in-flight', phase: trigger.phase, taskId: trigger.taskId };
	}
	inFlightTaskIds.add(trigger.taskId);
	const slot = await acquireProjectSlot(project.id, project.maxConcurrentJobs);
	if (!slot.acquired) {
		inFlightTaskIds.delete(trigger.taskId);
		// Pre-run deferral (concurrency limit): the dispatch returns to `pending`
		// (wait reason `project-capacity`) and is woken by a freed slot — it sits
		// outside the try/catch below and finalizes its own row.
		return handleConcurrencyDeferral(dispatch, job, trigger, project);
	}

	let runId: string | undefined;
	// A deferred outcome hands the run to `reenqueueDeferred`, which relies on
	// this durable marker to prevent a termination racing that queue hand-off
	// from resurrecting the run. Terminal outcomes consume the marker here.
	let preserveCancellationMarker = false;
	// Per-run abort signal, linked to the worker's shutdown signal (see
	// {@link linkRunAbortController}): the run is aborted by the worker's own
	// shutdown *or* a user-initiated dashboard termination (issue #166).
	const { controller: runAbort, detach } = linkRunAbortController(signal);
	try {
		// The global per-CLI default models (DB-backed app settings) — the fallback
		// tier between the project's own defaults and the coded defaults. Loaded once
		// per job, best-effort: a DB hiccup falls through to the coded defaults rather
		// than failing the run.
		const globalDefaults = await loadGlobalDefaults();
		// The CLIs this worker can actually run, for capability-aware target routing
		// (issue #346). Loaded once per job for the same reason, and equally
		// best-effort: an unknown answer routes to the phase's preferred target.
		const availableClis = await loadAvailableClis();
		const implementationUnplanned =
			trigger.phase === 'implementation' &&
			!(await wasPrecededByPlanning(project.id, trigger.taskId));

		// Record a run-history row for this agent-CLI invocation. Everything here is
		// best-effort (own try/catch inside the helpers, logged not thrown): the
		// dashboard is a secondary view, so a DB hiccup must never fail a real run.
		runId = await tryCreateRun(
			project,
			globalDefaults,
			availableClis,
			trigger,
			job,
			implementationUnplanned,
		);

		// The dispatch is now `running` against its run row; renew the lease to
		// cover this phase's own wall-clock timeout so a live run is never
		// reclaimed, while a dead one is reclaimed soon after the timeout passes.
		const effectiveTimeoutMs =
			agentOverrideFor(
				project,
				globalDefaults,
				availableClis,
				trigger.phase,
				job,
				implementationUnplanned,
			).timeoutMs ?? AGENT_TIMEOUT_MS;
		await markDispatchRunning(
			dispatch.id,
			runId,
			new Date(Date.now() + effectiveTimeoutMs + DISPATCH_LEASE_MARGIN_MS),
			trigger.taskId,
			trigger.phase,
		);

		// Make this run cancellable by id and honour a cancellation that already
		// landed (a deferred run terminated as its retry was dequeued).
		await beginRunCancellationTracking(runId, runAbort);

		const result = await runPhase(
			trigger,
			project,
			globalDefaults,
			availableClis,
			job,
			runId,
			runAbort.signal,
			implementationUnplanned,
		);
		// A run the harness killed for exceeding its wall-clock timeout is a terminal
		// failure, even in the rare case the agent trapped SIGTERM and still exited 0
		// before SIGKILL (so the phase read a stale/partial hand-off and "succeeded").
		// Re-route it through the failure path so the row finalizes `failed` with
		// `timedOut: true` rather than a contradictory `completed` (issue #165).
		if (result.agent.timedOut) {
			throw agentRunError(
				result.agent,
				`${phaseLabel(trigger.phase)} agent exceeded its wall-clock timeout`,
				` for task '${trigger.taskId}'`,
			);
		}
		// The phase itself logs the scannable `Phase finished - <label>` line (it
		// carries the run's result — PR URL, verdict, …); this is just the
		// orchestration-level echo, kept at debug so success shows one finish line.
		logger.debug('Job phase completed', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
		});
		await finalizeRun(
			runId,
			{
				status: 'completed',
				engine: result.agent.cli,
				exitCode: result.agent.exitCode,
				timedOut: result.agent.timedOut,
				durationMs: result.agent.durationMs,
				usage: result.agent.usage,
				// Only a Review run carries a verdict; every other phase leaves it
				// undefined, so the column is written only for reviews (issue #218).
				reviewVerdict: result.verdict,
				// Same: only a Review run carries a safety-cap slot/automation outcome
				// (issue #235).
				reviewOrdinal: result.reviewOrdinal,
				reviewAutomationOutcome: result.automationOutcome,
			},
			result.agent,
		);
		await tryCompleteDispatch(dispatch.id, 'phase-succeeded');
		if (trigger.phase === 'planning' || trigger.phase === 'implementation') {
			await selfEnqueueNextPhase(project, trigger.workItem, result.movedTo);
		}
		// Ordering matters: this must run *after* `tryCompleteDispatch` above. The
		// merge dispatch it persists is linked to this same `runId`, and the
		// partial unique `uq_dispatches_active_run` index (issue #284) allows only
		// one non-terminal dispatch per run — creating it while the Review dispatch
		// is still active would raise a unique violation that `requestMergeAutomation`
		// only swallows, silently dropping the merge. Completing the Review dispatch
		// first drops it out of that partial index, so the insert is safe.
		await requestMergeAutomationIfEligible(trigger, project, runId, result.verdict);
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
		const outcome = await handlePhaseFailure(err, job, trigger, project, runId);
		preserveCancellationMarker = outcome.status === 'phase-deferred';
		await finalizeFailedRun(runId, outcome, err);
		// Settle the durable dispatch to match: a deferral persists its derived
		// retry intent *before* any wake-up is queued (crash-safe — issue #284); a
		// user termination cancels rather than fails, so nothing resurrects it.
		// All swallowed on error: a bookkeeping failure must never rethrow into a
		// BullMQ retry that would re-run a non-idempotent agent — a dispatch left
		// `leased`/`running` is reclaimed by the reconciler's lease sweep instead.
		try {
			if (outcome.status === 'phase-deferred') {
				await settleDispatchRetry(dispatch, job, outcome);
			} else if (outcome.status === 'phase-failed') {
				if (outcome.cancelled) {
					await cancelClaimedDispatch(dispatch.id, RUN_CANCELLED_MESSAGE);
				} else {
					await failDispatch(dispatch.id, outcome.error);
				}
			}
		} catch (settleErr) {
			logger.error('Failed to settle dispatch after phase failure (lease sweep will repair)', {
				dispatchId: dispatch.id,
				error: describeError(settleErr),
			});
		}
		return outcome;
	} finally {
		// Detach the shutdown listener and drop this run from the cancellation
		// registry now that it has settled. A deferred outcome deliberately keeps
		// its marker until `reenqueueDeferred` observes it: a dashboard termination
		// can land after `deferred` is persisted but before the retry is queued.
		// Terminal outcomes clear it so a stale request cannot terminate a later
		// re-run that reuses this run id.
		detach();
		if (runId) {
			unregisterRunController(runId);
			if (!preserveCancellationMarker) await clearRunCancellation(runId);
		}
		// Release the slot once the run settles (success, failure, or deferral) so
		// a later legitimate dispatch for the same task — a genuine retry, or a
		// re-run after this one finished — isn't blocked. A deferred job is
		// re-enqueued and re-enters `processJob` fresh, past this release.
		if (slot.tracked) {
			await releaseProjectSlot(project.id);
			// A slot just freed — wake the next capacity-blocked dispatch for this
			// project (issues #214/#219, #284) so SCM work blocked only by concurrency
			// runs ahead of new board work. No-op when nothing is pending or the
			// policy is off; never reserves a slot.
			await promoteNextCapacityDispatch(
				project.id,
				project.pipeline?.prioritizeContinuations !== false,
			);
		}
		inFlightTaskIds.delete(trigger.taskId);
	}
}
