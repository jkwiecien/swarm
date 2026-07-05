/**
 * The router's BullMQ producer — the concrete implementation behind the
 * `src/router/enqueue.ts` seam (SWARM-35). It turns a validated {@link SwarmJob}
 * into a queued job on {@link QUEUE_NAME}, which the worker consumer
 * (`src/worker/consumer.ts`) pulls off and processes.
 *
 * Mirrors Cascade's `src/queue/client.ts`: a lazy `Queue` singleton so importing
 * this module is free (no Redis connection until the first enqueue) and both
 * enqueue seams share one connection, plus a single `add()` helper they call.
 */

import { Queue } from 'bullmq';
import { requireEnv } from '../lib/env.js';
import { parseRedisUrl } from '../lib/redis.js';
import { QUEUE_NAME, type SwarmJob } from './jobs.js';

let queue: Queue<SwarmJob> | null = null;

/**
 * Lazily construct the shared producer queue. `REDIS_URL` is read here, not at
 * module load, so a process that imports this module without ever enqueuing
 * (e.g. a unit test) never needs Redis configured.
 */
function getQueue(): Queue<SwarmJob> {
	if (!queue) {
		queue = new Queue<SwarmJob>(QUEUE_NAME, {
			connection: parseRedisUrl(requireEnv('REDIS_URL')),
			defaultJobOptions: {
				// Only infrastructure failures throw out of the worker's `processJob`
				// (unknown project, worktree/graft/spawn) — and all of those throw
				// *before* the agent CLI runs, so a bounded retry can't re-run a
				// non-idempotent agent. Agent failures are returned as an outcome, not
				// thrown, precisely so they don't trigger these retries.
				attempts: 3,
				backoff: { type: 'exponential', delay: 5_000 },
				// Keep Redis from growing unbounded; keep enough history to debug.
				removeOnComplete: { age: 24 * 60 * 60, count: 100 },
				removeOnFail: { age: 7 * 24 * 60 * 60 },
			},
		});
	}
	return queue;
}

/**
 * Enqueue a job for the worker. Returns the assigned BullMQ job id.
 *
 * `deliveryId` (GitHub's `X-GitHub-Delivery`) is used as the BullMQ job id when
 * present: BullMQ ignores an `add()` for a job id that already exists, so a
 * redelivered webhook — GitHub retries deliveries that don't 2xx promptly —
 * dedupes to a single job instead of re-running the pipeline. Events without a
 * delivery id (synthetic/manual) get a BullMQ-assigned id and no dedup.
 */
export async function enqueueJob(job: SwarmJob): Promise<string | undefined> {
	const added = await getQueue().add(
		job.type,
		job,
		job.deliveryId ? { jobId: job.deliveryId } : undefined,
	);
	return added.id;
}

/**
 * Close the producer connection — called from the router's shutdown handler so
 * the process exits cleanly instead of hanging on an open Redis socket. A no-op
 * if nothing was ever enqueued (the queue is created lazily).
 */
export async function closeQueue(): Promise<void> {
	if (queue) {
		await queue.close();
		queue = null;
	}
}
