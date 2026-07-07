/**
 * Worker entry point — the BullMQ consumer side of the router→worker queue
 * (ai/ARCHITECTURE.md "Components"). A long-lived process, not Cascade's
 * one-container-per-job model: the MVP runs one worker on the host (NOT in
 * Docker Compose — it needs the developer's PATH/auth for git and the agent
 * CLIs), pulling jobs off `swarm-jobs` one at a time (env-overridable pool).
 */

// Single canonical integration registration — same entrypoint as the router,
// so a provider can never be registered on one runtime surface but not another.
import '../integrations/entrypoint.js';

import { Worker } from 'bullmq';
import { optionalEnv, requireEnv } from '../lib/env.js';
import { configureLogger, logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { QUEUE_NAME, type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
import { enqueueDelayedRetry } from '../queue/producer.js';
import { createTriggerRegistry, registerBuiltInTriggers } from '../triggers/index.js';
import { type JobOutcome, processJob } from './consumer.js';

// Tag every line this process emits so router and worker logs stay
// distinguishable in a shared stream (ai/ARCHITECTURE.md "Observability").
// This runs after the hoisted imports above (notably the integrations
// entrypoint), so any module that logs at import time would emit an untagged
// line before this call — nothing does today; keep it that way.
configureLogger({ component: 'worker' });

const rawConcurrency = optionalEnv('SWARM_WORKER_CONCURRENCY', '1');
const concurrency = Number(rawConcurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
	throw new Error(`SWARM_WORKER_CONCURRENCY must be a positive integer, got '${rawConcurrency}'`);
}

const registry = createTriggerRegistry();
registerBuiltInTriggers(registry);

// Aborted on SIGTERM/SIGINT so an in-flight agent run is killed (SIGTERM→SIGKILL
// via `runAgentCli`'s signal option) instead of outliving the stop grace period.
const shutdown = new AbortController();

const worker = new Worker(
	QUEUE_NAME,
	// Job data is untrusted at this boundary (anything could have been pushed to
	// Redis) — validate before acting on it.
	async (job) => processJob(SwarmJobSchema.parse(job.data), registry, shutdown.signal),
	{
		connection: parseRedisUrl(requireEnv('REDIS_URL')),
		concurrency,
		// Agent runs aren't idempotent (see processJob's doc comment), so a job
		// interrupted by process death must fail visibly rather than be re-queued
		// by the stalled-job checker and silently re-run on restart.
		maxStalledCount: 0,
	},
);

worker.on('completed', (job, outcome: JobOutcome) => {
	logger.info('Job completed', { jobId: job.id, name: job.name, outcome });
	// A rate-limited or worker-aborted phase completes (from BullMQ's view) as
	// `phase-deferred`: re-enqueue it delayed so it retries once quota is back, or
	// once whatever restarted the worker mid-run has settled (issue #91; aborted
	// case added after a dev `--watch` restart permanently failed an in-flight
	// review). Done here, not in `processJob`, to keep the consumer
	// BullMQ-agnostic — the entrypoint owns the queue. Fire-and-forget with its
	// own error handling so a re-enqueue failure can't reject the completed-event
	// handler; the (small) window where a worker crash between completion and
	// re-enqueue loses the retry is an accepted MVP tradeoff.
	if (outcome?.status === 'phase-deferred') {
		void reenqueueDeferred(job.id, job.data, outcome);
	}
});

/**
 * Re-enqueue a deferred job (rate-limited or worker-aborted) with its retry
 * counter bumped, so the consumer can cap the loop. `data` is re-validated (it
 * round-trips through Redis) before the counter is incremented.
 */
async function reenqueueDeferred(
	jobId: string | undefined,
	data: unknown,
	outcome: Extract<JobOutcome, { status: 'phase-deferred' }>,
): Promise<void> {
	try {
		const parsed = SwarmJobSchema.parse(data);
		const next: SwarmJob = {
			...parsed,
			rateLimitRetryAttempt: (parsed.rateLimitRetryAttempt ?? 0) + 1,
		};
		await enqueueDelayedRetry(next, outcome.retryDelayMs);
		logger.info('Rate-limited phase re-enqueued for retry', {
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
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
worker.on('failed', (job, err) => {
	logger.error('Job failed', { jobId: job?.id, name: job?.name, error: err.message });
});
// Connection-level errors (Redis down, …); BullMQ retries internally, but an
// unhandled 'error' event would crash the process.
worker.on('error', (err) => {
	logger.error('Worker queue error', { error: err.message });
});

logger.info('swarm-worker started', { queue: QUEUE_NAME, concurrency });

// On shutdown (Ctrl+C sends SIGINT; a `kill`/supervisor sends SIGTERM), abort
// the in-flight agent run (it completes as `phase-failed`; each phase runs its
// own worktree cleanup in a `finally`), then let worker.close() wait for the
// job to finish before exiting.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		logger.info(`Received ${signal} — aborting in-flight agent run and closing worker`);
		shutdown.abort();
		void worker.close().then(
			() => process.exit(0),
			(err) => {
				logger.error('Worker close failed', {
					error: err instanceof Error ? err.message : String(err),
				});
				process.exit(1);
			},
		);
	});
}
