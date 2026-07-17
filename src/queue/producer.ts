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

import { randomUUID } from 'node:crypto';
import { Job, Queue } from 'bullmq';
import type { AgentCli } from '../harness/agent-cli.js';
import type { ReasoningLevel } from '../harness/models.js';
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
 * the dedup we want. A manually reconstructed retry instead requests a unique
 * id: the retained completed job for its old attempt must not suppress the new
 * operator-requested run. With no delivery id there's nothing stable to key on,
 * so we also fall back to a time+random unique id. Either way the id is colon-free
 * (BullMQ reserves `:` for its own namespacing), same constraint as
 * {@link scheduleCoalescedJob}.
 */
export async function enqueueDelayedRetry(
	job: SwarmJob,
	delayMs: number,
	options?: { unique?: boolean },
): Promise<string | undefined> {
	const attempt = job.rateLimitRetryAttempt ?? 0;
	const retryBaseId = job.deliveryId
		? `retry_${job.type}_${job.deliveryId.replace(/:/g, '_')}_attempt${attempt}`
		: `retry_${job.type}`;
	const jobId = options?.unique
		? `${retryBaseId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
		: job.deliveryId
			? retryBaseId
			: `${retryBaseId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const priority = priorityFor(job);
	const added = await getQueue().add(job.type, job, {
		jobId,
		delay: delayMs,
		...(priority !== undefined ? { priority } : {}),
	});
	return added.id;
}

/**
 * Fire a deferred run's pending retry *now* — the immediate-retry primitive
 * behind the `runs.retryNow` tRPC mutation ("Retry now", issue #136).
 *
 * A deferred run always has exactly one pending BullMQ retry job sitting delayed
 * in Redis (`enqueueDelayedRetry` re-enqueued it), and — since issue #136 — that
 * job carries the originating `runId` in its data. We locate it by that id and
 * `promote()` it, which BullMQ moves straight from `delayed` to `waiting` so the
 * worker picks it up on its next free slot instead of after the remaining delay.
 * Operating on that single pending job (rather than enqueuing a fresh one) is
 * what keeps a manual retry from racing the automatic one into two concurrent
 * runs — there is only ever the one job.
 *
 * Its `rateLimitRetryAttempt` is reset to 0 before promoting so the manual retry
 * bypasses the automatic `MAX_RATE_LIMIT_RETRIES` cap (`src/worker/consumer.ts`)
 * — a human asking to retry gets a fresh budget rather than being re-capped the
 * instant the job runs.
 *
 * Returns `true` when a pending job was found and promoted, `false` when none
 * matched — the run is no longer in a promotable state (already picked up and
 * running, or its pending job was reaped). The caller turns `false` into an
 * actionable error rather than enqueuing a fresh job it can't reconstruct from a
 * run row alone.
 */
export async function promoteRetryForRun(
	runId: string,
	cli?: AgentCli,
	model?: string,
	reasoning?: ReasoningLevel,
	freshSession = false,
): Promise<boolean> {
	const q = getQueue();
	// A promotable retry is always `delayed` (it was scheduled with a delay).
	// `getWaiting()` is scanned too so a retry whose delay already elapsed but
	// hasn't been picked up yet still counts as "already retrying" and is left
	// alone rather than mistaken for absent.
	const [delayed, waiting] = await Promise.all([q.getDelayed(), q.getWaiting()]);
	const matches = (job: { data?: { runId?: string } }) => job.data?.runId === runId;

	// Apply the manual retry's overrides onto a pending job's data in place, then
	// persist. `getDelayed()`/`getWaiting()`'s element type distributes the SwarmJob
	// union into `Job<github> | Job<github-projects>`, whose `updateData` collapses
	// to an uncallable never-parameter; re-view it as the non-distributed
	// `Job<SwarmJob>` so the (union-typed) data round-trips through updateData. The
	// attempt counter is reset in place (a spread would widen the discriminated
	// union past itself) so the manual retry bypasses MAX_RATE_LIMIT_RETRIES.
	const applyOverrides = async (pending: (typeof delayed)[number]): Promise<void> => {
		const job = pending as Job<SwarmJob>;
		job.data.rateLimitRetryAttempt = 0;
		if (cli) job.data.cliOverride = cli;
		if (model) job.data.modelOverride = model;
		if (reasoning) job.data.reasoningOverride = reasoning;
		if (freshSession) {
			job.data.agentSessionId = randomUUID();
			delete job.data.resumeSession;
		}
		await job.updateData(job.data);
	};

	const pendingDelayed = delayed.find(matches);
	if (pendingDelayed) {
		await applyOverrides(pendingDelayed);
		await (pendingDelayed as Job<SwarmJob>).promote();
		return true;
	}

	// Already waiting (its delay elapsed) → it will run imminently on its own, so
	// there is nothing to promote; but it must still pick up the manual retry's
	// cli/model overrides, or the run relaunches on the *original* engine — the
	// confirmed regression where a `codex`/`gpt-5.6-terra` retry re-ran on
	// `antigravity` (issue #165). Update its data in place before it starts.
	const pendingWaiting = waiting.find(matches);
	if (pendingWaiting) {
		await applyOverrides(pendingWaiting);
		return true;
	}
	return false;
}

/**
 * Promote a delayed BullMQ job to `waiting` by its id — the pending-continuation
 * promotion primitive (issue #214), alongside {@link promoteRetryForRun}. When a
 * project slot frees, `processJob` takes the oldest pending continuation
 * (`src/worker/pending-continuations.ts`) and promotes its delayed fallback retry
 * so the worker's next free thread picks it up immediately (github priority beats
 * board priority) instead of after the 6-minute backoff.
 *
 * Returns `true` when the job was promoted (`delayed` → `waiting`) or is already
 * runnable (`waiting` — its delay elapsed, so it will run imminently on its own);
 * `false` when no such job exists (reaped, or already active/completed) — nothing
 * to promote, and the freed slot simply goes to whatever the queue serves next.
 * No slot is ever reserved: we only promote an already-enqueued retry of a real,
 * already-dispatched event.
 */
export async function promoteJobById(jobId: string): Promise<boolean> {
	const job = await Job.fromId(getQueue(), jobId);
	if (!job) return false;
	const state = await job.getState();
	if (state === 'delayed') {
		await job.promote();
		return true;
	}
	return state === 'waiting';
}

/**
 * Remove a deferred run's pending BullMQ retry job(s) — the queue half of the
 * dashboard's "Terminate" action for a `deferred` run (issue #166). A deferred
 * run has exactly one delayed retry job carrying its `runId`; removing it before
 * the run row is flipped to `failed` guarantees no automatic pickup resurrects a
 * run the user just terminated (leaving neither an orphaned job nor a false
 * `deferred` row).
 *
 * Only *pending* jobs (delayed/waiting) are removable here — a job BullMQ already
 * moved to `active` (a worker is mid-processing it) isn't in these sets and isn't
 * removed; that pickup race is handled instead by the worker honouring the
 * durable cancellation flag (`src/queue/cancellation.ts`). Matches on the same
 * `data.runId` as {@link promoteRetryForRun}. Returns how many jobs were removed.
 */
export async function removePendingRetryForRun(runId: string): Promise<number> {
	const q = getQueue();
	const [delayed, waiting] = await Promise.all([q.getDelayed(), q.getWaiting()]);
	const matches = (job: { data?: { runId?: string } }) => job.data?.runId === runId;
	const pending = [...delayed, ...waiting].filter(matches);
	await Promise.all(pending.map((job) => job.remove()));
	return pending.length;
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
