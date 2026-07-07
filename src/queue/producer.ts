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
 * PM-board events (`github-projects`: card status changes that dispatch
 * planning/implementation, which can run for minutes) are demoted below
 * BullMQ's implicit default priority so PR review-lifecycle events (`github`:
 * opened / checks / reviews) never sit queued behind one. BullMQ ranks 0
 * (unset) as highest, so `github` jobs need no override — only
 * `github-projects` jobs get pushed down. Without this, a card dragged into
 * Planning/In progress right as a PR opens can leave that PR's review waiting
 * out the whole implementation run under `SWARM_WORKER_CONCURRENCY=1`, and
 * even at 2 it still competes for the same limited slots.
 */
const PM_BOARD_JOB_PRIORITY = 10;

function priorityFor(job: SwarmJob): number | undefined {
	return job.type === 'github-projects' ? PM_BOARD_JOB_PRIORITY : undefined;
}

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
 *
 * The dedup guarantee is retention-scoped, not permanent: it only holds while
 * the completed job still lives in Redis (`removeOnComplete` below). Under
 * bursty load the `count: 100` cap can evict a completed job sooner than its
 * 24h age, freeing the `jobId` so a later redelivery of that same delivery id
 * would re-run. Low risk in practice — GitHub's redelivery window is short.
 */
export async function enqueueJob(job: SwarmJob): Promise<string | undefined> {
	const priority = priorityFor(job);
	const opts =
		job.deliveryId || priority !== undefined
			? {
					...(job.deliveryId ? { jobId: job.deliveryId } : {}),
					...(priority !== undefined ? { priority } : {}),
				}
			: undefined;
	const added = await getQueue().add(job.type, job, opts);
	return added.id;
}

/**
 * Schedule `job` to run after `delayMs`, coalesced on `coalesceKey`: any
 * pending (delayed or waiting) job already scheduled under the same key is
 * removed first, so N events for the same key collapse into a single deferred
 * run rather than a pile-up. The primitive behind the `pr-review` handler's
 * incomplete-check recheck (`src/triggers/handlers/review.ts`), ported from
 * Cascade's `scheduleCoalescedJob` (`src/router/queue.ts`).
 *
 * `coalesceKey` is used as the BullMQ *job name* (not its id): `getDelayed()` /
 * `getWaiting()` are matched on name to find the prior pending job. The name is
 * cosmetic to the worker, which processes every job on the queue regardless of
 * name (`src/worker/index.ts`). The new job gets a unique id so it never
 * collides with the superseded one or with a `deliveryId`-keyed job.
 *
 * Only *pending* jobs are superseded — active/completed/failed jobs are left
 * alone (an active one is already doing the work; a finished one is real past
 * intent). The getDelayed→remove→add sequence isn't atomic, so two concurrent
 * schedules for one key can both fire; that's equivalent to two webhooks
 * landing back to back and is absorbed downstream by the review-dispatch dedup
 * claim (`src/triggers/review-dispatch-dedup.ts`).
 */
export async function scheduleCoalescedJob(
	job: SwarmJob,
	coalesceKey: string,
	delayMs: number,
): Promise<void> {
	const q = getQueue();

	const [delayed, waiting] = await Promise.all([q.getDelayed(), q.getWaiting()]);
	const pending = [...delayed, ...waiting].filter((j) => j.name === coalesceKey);
	await Promise.all(pending.map((j) => j.remove()));

	// Colon-free unique id: BullMQ rejects custom ids containing `:` (reserved
	// for its own key namespacing), and the id must not collide with a
	// superseded job or a delivery-id-keyed one. `Date.now()` + a random suffix
	// gives per-schedule uniqueness without a shared counter.
	const jobId = `coalesce_${coalesceKey.replace(/:/g, '_')}_${Date.now()}_${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const priority = priorityFor(job);
	await q.add(coalesceKey, job, {
		jobId,
		delay: delayMs,
		...(priority !== undefined ? { priority } : {}),
	});
}

/**
 * Re-enqueue a job to run after `delayMs` — the worker's rate-limit retry path
 * (`src/worker/index.ts`, on a `phase-deferred` outcome; issue #91). Unlike
 * {@link enqueueJob} this never reuses the plain delivery id: the original
 * delivery-id-keyed job is still sitting completed in Redis, and BullMQ would
 * silently drop an `add()` that reused its id.
 *
 * The id is keyed on `(deliveryId, rateLimitRetryAttempt)` when a delivery id is
 * present, so a given attempt of a given delivery maps to exactly one job id.
 * That restores per-attempt idempotency: should BullMQ's `completed` event ever
 * fire twice for one job, the second re-enqueue reuses the id and BullMQ drops it
 * (rather than stacking a duplicate retry) — the drop we normally avoid becomes
 * the dedup we want. With no delivery id there's nothing stable to key on, so we
 * fall back to a time+random unique id. Either way the id is colon-free (BullMQ
 * reserves `:` for its own namespacing), same constraint as
 * {@link scheduleCoalescedJob}.
 */
export async function enqueueDelayedRetry(
	job: SwarmJob,
	delayMs: number,
): Promise<string | undefined> {
	const attempt = job.rateLimitRetryAttempt ?? 0;
	const jobId = job.deliveryId
		? `retry_${job.type}_${job.deliveryId.replace(/:/g, '_')}_attempt${attempt}`
		: `retry_${job.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const priority = priorityFor(job);
	const added = await getQueue().add(job.type, job, {
		jobId,
		delay: delayMs,
		...(priority !== undefined ? { priority } : {}),
	});
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
