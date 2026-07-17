import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isRunCancellationRequested } from '../queue/cancellation.js';
import { type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
import { enqueueDelayedRetry, removePendingRetryForRun } from '../queue/producer.js';
import type { JobOutcome } from './consumer.js';
import { registerPendingContinuation } from './pending-continuations.js';

/**
 * Hand a deferred run back to BullMQ. A dashboard termination can arrive after
 * the consumer persisted `deferred` but before this completed-handler enqueues
 * the retry. Keep the durable cancellation marker in place and check it both
 * before and after enqueueing: the second check closes that hand-off window by
 * removing a retry that appeared after the terminator's first queue scan.
 */
export async function reenqueueDeferred(
	jobId: string | undefined,
	data: unknown,
	outcome: Extract<JobOutcome, { status: 'phase-deferred' }>,
): Promise<void> {
	try {
		const parsed = SwarmJobSchema.parse(data);
		// Retry intent is derived from this outcome. Do not let a stale flag from an
		// earlier queued job turn a pre-provisioning capacity retry into a branch
		// resume.
		const {
			resumePmPhase,
			resumeSession: _resumeSession,
			resumeDelivery: _resumeDelivery,
			...job
		} = parsed;
		const next: SwarmJob = {
			...job,
			rateLimitRetryAttempt: (job.rateLimitRetryAttempt ?? 0) + 1,
			// Carry the originating run row forward (issue #136) so the retry resets
			// that same row instead of inserting a second one. `outcome.runId` wins
			// over any stale value on `parsed` (they match on a retry; only the
			// outcome knows the row a fresh webhook's first run just created).
			...(outcome.runId ? { runId: outcome.runId } : {}),
			// Keep PM dispatch intent when this attempt already carried it, or when
			// the outcome explicitly says the phase started. Branch reuse is governed
			// by the separate durable provisioning checkpoint on `job`.
			...((outcome.pmPhaseStarted || resumePmPhase !== undefined) &&
			job.type === 'github-projects' &&
			(outcome.phase === 'planning' || outcome.phase === 'implementation')
				? { resumePmPhase: outcome.phase }
				: {}),
			// Continue the prior agent session on the retry (any phase, any CLI) when
			// the deferral was a resumable one (rate-limit/timeout). Separate from
			// `resumePmPhase`, which is only the github-projects board-dispatch signal.
			...(outcome.resumable ? { resumeSession: true } : {}),
			// Delivery retries reuse a valid progress-marked worktree, independent of
			// whether the completed agent run exposed a session id.
			...(outcome.resumeDelivery ? { resumeDelivery: true } : {}),
			// A prioritized continuation (issue #214) already holds its dispatch dedup
			// claim; tell the retry's handler to reuse it rather than re-claim (which,
			// fired within the refreshed TTL, would drop the run as a duplicate).
			...(outcome.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
		};

		if (outcome.runId && (await isRunCancellationRequested(outcome.runId))) {
			logger.debug('Skipped retry for a user-terminated deferred run', {
				jobId,
				runId: outcome.runId,
			});
			return;
		}

		const retryJobId = await enqueueDelayedRetry(next, outcome.retryDelayMs);

		// If termination raced the queue hand-off, its queue scan may have run
		// before the retry existed. The durable marker makes that ordering visible
		// here, and the delayed job cannot become active before we remove it.
		if (outcome.runId && (await isRunCancellationRequested(outcome.runId))) {
			await removePendingRetryForRun(outcome.runId);
			logger.debug('Removed retry enqueued during deferred-run termination', {
				jobId,
				runId: outcome.runId,
			});
			return;
		}

		// Register a prioritized continuation (issue #214) so a freed project slot can
		// promote its delayed retry ahead of new board work. Best-effort and after the
		// cancellation checks: the delayed retry above is the safety net if the
		// registry write is lost, and a terminated run must not be re-registered.
		if (outcome.pendingContinuation && retryJobId) {
			await registerPendingContinuation(parsed.projectId, {
				jobId: retryJobId,
				taskId: outcome.taskId,
				phase: outcome.phase,
				enqueuedAt: Date.now(),
			});
		}

		logger.debug('Rate-limited phase re-enqueued for retry', {
			jobId,
			phase: outcome.phase,
			taskId: outcome.taskId,
			retryDelayMs: outcome.retryDelayMs,
			attempt: next.rateLimitRetryAttempt,
		});
	} catch (err) {
		logger.error('Failed to re-enqueue rate-limited phase', {
			jobId,
			taskId: outcome.taskId,
			error: describeError(err),
		});
	}
}
