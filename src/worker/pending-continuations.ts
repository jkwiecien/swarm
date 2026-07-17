/**
 * Pending-dispatch registry, Redis-backed (issues #214/#262).
 *
 * A phase blocked *solely* by a project's concurrency limit is retained here
 * with the job that already resolved it. This avoids replaying a stale webhook
 * after an arbitrary delay: in particular, a Planning card can still be in
 * Planning when its slot frees, but its status-dedup key has expired. The stored
 * `resumePmPhase` dispatch intent makes that retry unambiguous.
 *
 * One Redis HASH per project (`swarm:pending-continuations:<id>`), keyed by a
 * stable `<taskId>:<phase>` field so a re-deferral *replaces* rather than stacks.
 * The value is a JSON {@link PendingDispatch}. Mirrors
 * `project-concurrency.ts`'s shape: a lazy fail-fast `Redis` singleton
 * (`maxRetriesPerRequest: 1`) with an `'error'` listener.
 *
 * Every operation swallows+logs Redis errors and fails open (register no-ops,
 * take returns `null`): a registry hiccup must never fail a real run. Single-worker
 * MVP — a multi-worker deployment inherits
 * `project-concurrency`'s documented per-worker-lease caveat.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import type { SwarmJob } from '../queue/jobs.js';
import type { TriggerPhase } from '../triggers/types.js';

const KEY_NS = 'swarm:pending-continuations:';

let redisInstance: Redis | null = null;

/**
 * A retained, concurrency-blocked phase awaiting a freed project slot.
 */
export type PendingDispatch = {
	taskId: string;
	phase: TriggerPhase;
	enqueuedAt: number;
	/** The exact dispatch intent, rather than a webhook that must be interpreted again. */
	job: SwarmJob;
	/** SCM continuations jump ahead of new board work when the project opts in. */
	continuation: boolean;
};

/** Stable per-task+phase field so a re-deferral replaces its prior entry. */
function fieldFor(entry: { taskId: string; phase: TriggerPhase }): string {
	return `${entry.taskId}:${entry.phase}`;
}

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('pending-continuations: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/** Parse a stored entry, returning `undefined` for anything malformed. */
function parseEntry(raw: string): PendingDispatch | undefined {
	try {
		const value = JSON.parse(raw) as Partial<PendingDispatch>;
		if (
			typeof value.taskId === 'string' &&
			typeof value.phase === 'string' &&
			typeof value.enqueuedAt === 'number' &&
			value.job !== undefined &&
			typeof value.continuation === 'boolean'
		) {
			return value as PendingDispatch;
		}
	} catch {
		// fall through
	}
	return undefined;
}

/**
 * Register (or replace) a project's pending dispatch — `HSET` keyed on
 * `<taskId>:<phase>`, so a job re-deferred while already pending overwrites its
 * prior entry rather than stacking a second one. Idempotent; fails open.
 */
export async function registerPendingContinuation(
	projectId: string,
	entry: PendingDispatch,
): Promise<void> {
	try {
		await getRedis().hset(`${KEY_NS}${projectId}`, fieldFor(entry), JSON.stringify(entry));
	} catch (err) {
		logger.warn('pending-continuations: register failed', {
			projectId,
			error: String(err),
		});
	}
}

/**
 * Return the next pending dispatch. With continuation priority on,
 * the oldest continuation wins; otherwise this is strict FIFO. Malformed entries
 * are dropped in passing so a corrupt value can't wedge the registry.
 */
export async function takeNextPendingContinuation(
	projectId: string,
	prioritizeContinuations: boolean,
): Promise<PendingDispatch | null> {
	const key = `${KEY_NS}${projectId}`;
	try {
		const redis = getRedis();
		const all = await redis.hgetall(key);
		let oldestField: string | undefined;
		let oldest: PendingDispatch | undefined;
		for (const [field, raw] of Object.entries(all)) {
			const parsed = parseEntry(raw);
			if (!parsed) {
				await redis.hdel(key, field);
				continue;
			}
			const shouldReplace =
				!oldest ||
				(prioritizeContinuations && parsed.continuation !== oldest.continuation
					? parsed.continuation
					: parsed.enqueuedAt < oldest.enqueuedAt);
			if (shouldReplace) {
				oldest = parsed;
				oldestField = field;
			}
		}
		if (!oldest || !oldestField) return null;
		return oldest;
	} catch (err) {
		logger.warn('pending-continuations: take failed', {
			projectId,
			error: String(err),
		});
		return null;
	}
}

/** Remove a dispatch after BullMQ accepted it for execution. */
export async function removePendingContinuation(
	projectId: string,
	entry: Pick<PendingDispatch, 'taskId' | 'phase'>,
): Promise<void> {
	try {
		await getRedis().hdel(`${KEY_NS}${projectId}`, fieldFor(entry));
	} catch (err) {
		logger.warn('pending-continuations: remove failed', { projectId, error: String(err) });
	}
}

/** Remove a terminated run's pending dispatch so a later slot release cannot revive it. */
export async function removePendingContinuationForRun(runId: string): Promise<number> {
	try {
		const redis = getRedis();
		const keys = await redis.keys(`${KEY_NS}*`);
		let removed = 0;
		for (const key of keys) {
			const all = await redis.hgetall(key);
			for (const [field, raw] of Object.entries(all)) {
				const entry = parseEntry(raw);
				if (entry?.job.runId === runId) {
					await redis.hdel(key, field);
					removed += 1;
				}
			}
		}
		return removed;
	} catch (err) {
		logger.warn('pending-continuations: remove-for-run failed', { runId, error: String(err) });
		return 0;
	}
}

/** How many pending continuations a project holds (`HLEN`) — for logging/tests. */
export async function countPendingContinuations(projectId: string): Promise<number> {
	try {
		return await getRedis().hlen(`${KEY_NS}${projectId}`);
	} catch (err) {
		logger.warn('pending-continuations: count failed', { projectId, error: String(err) });
		return 0;
	}
}

/**
 * Drop a project's whole pending-dispatch registry. This is retained for explicit
 * administrative cleanup; worker startup deliberately does not call it.
 */
export async function clearPendingContinuations(projectId: string): Promise<void> {
	try {
		await getRedis().del(`${KEY_NS}${projectId}`);
	} catch (err) {
		logger.warn('pending-continuations: clear failed', { projectId, error: String(err) });
	}
}
