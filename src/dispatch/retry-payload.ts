/**
 * Pure derivation of a deferred dispatch's next-attempt payload (issue #284;
 * previously buried in `src/worker/deferred-retry.ts`'s enqueue path). The
 * worker persists this payload on the dispatch row *when it settles the
 * deferral* — before any queue work — so the retry intent survives a crash
 * between settle and wake-up publication, instead of living only inside a
 * fire-and-forget BullMQ handler.
 */

import type { SwarmJob } from '../queue/jobs.js';
import type { TriggerPhase } from '../triggers/types.js';

/** The slice of a `phase-deferred` outcome the payload derivation needs. */
export interface DeferredRetryIntent {
	phase: TriggerPhase;
	runId?: string;
	/** Resume the preserved agent session on retry (rate-limit/timeout/stalled). */
	resumable: boolean;
	/** Resume deterministic-delivery progress from the preserved worktree. */
	resumeDelivery?: boolean;
	/** A PM-driven phase was actually entered before it deferred. */
	pmPhaseStarted?: boolean;
	/** The retry must reuse the held review-dispatch dedup claim (issue #214). */
	continuationDispatchClaimed?: boolean;
}

/**
 * The payload a scheduled retry runs with. Retry intent is derived from this
 * outcome — a stale flag from an earlier queued job must not turn a
 * pre-provisioning capacity retry into a branch resume, so the prior
 * `resumePmPhase`/`resumeSession`/`resumeDelivery` flags are dropped and
 * re-derived.
 */
export function deriveRetryJobPayload(parsed: SwarmJob, intent: DeferredRetryIntent): SwarmJob {
	const {
		resumePmPhase,
		resumeSession: _resumeSession,
		resumeDelivery: _resumeDelivery,
		...job
	} = parsed;
	return {
		...job,
		rateLimitRetryAttempt: (job.rateLimitRetryAttempt ?? 0) + 1,
		// Carry the originating run row forward (issue #136) so the retry resets
		// that same row instead of inserting a second one. `intent.runId` wins
		// over any stale value on `parsed`.
		...(intent.runId ? { runId: intent.runId } : {}),
		// Keep PM dispatch intent when this attempt already carried it, or when
		// the outcome says the phase started. Branch reuse is governed by the
		// separate durable provisioning checkpoint on `job`.
		...((intent.pmPhaseStarted || resumePmPhase !== undefined) &&
		job.type === 'github-projects' &&
		(intent.phase === 'planning' || intent.phase === 'implementation')
			? { resumePmPhase: intent.phase }
			: {}),
		// Continue the prior agent session on the retry when the deferral was a
		// resumable one; separate from `resumePmPhase`, which is only the
		// github-projects board-dispatch signal.
		...(intent.resumable ? { resumeSession: true } : {}),
		// Delivery retries reuse a valid progress-marked worktree, independent of
		// whether the completed agent run exposed a session id.
		...(intent.resumeDelivery ? { resumeDelivery: true } : {}),
		// A prioritized continuation already holds its dispatch dedup claim; the
		// retry's handler must reuse it rather than re-claim (issue #214).
		...(intent.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
	};
}

/**
 * The payload a project-capacity-blocked dispatch waits with: the attempt
 * counter is *not* consumed (waiting on a slot isn't a failure), but PM
 * dispatch intent and the held dedup claim are recorded so the eventual wake-up
 * re-enters its original phase unambiguously even after status-dedup TTLs
 * expire.
 */
export function deriveCapacityPendingPayload(
	parsed: SwarmJob,
	intent: DeferredRetryIntent,
): SwarmJob {
	return {
		...parsed,
		...(intent.runId ? { runId: intent.runId } : {}),
		...(parsed.type === 'github-projects' &&
		(intent.phase === 'planning' || intent.phase === 'implementation')
			? { resumePmPhase: intent.phase }
			: {}),
		...(intent.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
	};
}
