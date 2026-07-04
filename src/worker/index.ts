/**
 * Worker entry point — the BullMQ consumer side of the router→worker queue
 * (ai/ARCHITECTURE.md "Components"). A long-lived process, not Cascade's
 * one-container-per-job model: the MVP runs one worker service in Docker
 * Compose, pulling jobs off `swarm-jobs` one at a time (env-overridable pool).
 */

// Single canonical integration registration — same entrypoint as the router,
// so a provider can never be registered on one runtime surface but not another.
import '../integrations/entrypoint.js';

import { Worker } from 'bullmq';
import { optionalEnv, requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { QUEUE_NAME, SwarmJobSchema } from '../queue/jobs.js';
import { createTriggerRegistry, registerBuiltInTriggers } from '../triggers/index.js';
import { processJob } from './consumer.js';

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

worker.on('completed', (job, outcome) => {
	logger.info('Job completed', { jobId: job.id, name: job.name, outcome });
});
worker.on('failed', (job, err) => {
	logger.error('Job failed', { jobId: job?.id, name: job?.name, error: err.message });
});
// Connection-level errors (Redis down, …); BullMQ retries internally, but an
// unhandled 'error' event would crash the process.
worker.on('error', (err) => {
	logger.error('Worker queue error', { error: err.message });
});

logger.info('swarm-worker started', { queue: QUEUE_NAME, concurrency });

// Docker sends SIGTERM on `compose down`/`stop`; abort the in-flight agent run
// (it completes as `agent-failed`, cleanup still runs), then let worker.close()
// wait for the job to finish before exiting.
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
