import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isRunCancellationRequested } from '../queue/cancellation.js';
import { type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
import { enqueueDelayedRetry, removePendingRetryForRun } from '../queue/producer.js';
import type { JobOutcome } from './consumer.js';

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
		const next: SwarmJob = {
			...parsed,
			rateLimitRetryAttempt: (parsed.rateLimitRetryAttempt ?? 0) + 1,
			// Carry the originating run row forward (issue #136) so the retry resets
			// that same row instead of inserting a second one. `outcome.runId` wins
			// over any stale value on `parsed` (they match on a retry; only the
			// outcome knows the row a fresh webhook's first run just created).
			...(outcome.runId ? { runId: outcome.runId } : {}),
			...(parsed.type === 'github-projects' &&
			(outcome.phase === 'planning' || outcome.phase === 'implementation')
				? { resumePmPhase: outcome.phase }
				: {}),
		};

		if (outcome.runId && (await isRunCancellationRequested(outcome.runId))) {
			logger.debug('Skipped retry for a user-terminated deferred run', {
				jobId,
				runId: outcome.runId,
			});
			return;
		}

		await enqueueDelayedRetry(next, outcome.retryDelayMs);

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
