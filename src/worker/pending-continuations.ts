/**
 * Pending-continuation registry, Redis-backed (issue #214).
 *
 * An SCM-driven continuation of already-active pipeline work that is
 * blocked *solely* by a project's concurrency limit is retained here as a
 * *pending continuation* rather than being buried under the generic rate-limit
 * backoff. When any of the project's slots frees, `processJob` promotes the
 * oldest pending continuation ahead of new Planning/Implementation work
 * (`promoteJobById`, `src/queue/producer.ts`) — the fix for issue #213, where a
 * `pull_request opened` arriving while Implementation finishes was left waiting
 * out the 6-minute backoff while a fresh board job took the freed slot.
 *
 * One Redis HASH per project (`swarm:pending-continuations:<id>`), keyed by a
 * stable `<taskId>:<phase>` field so a re-deferral *replaces* rather than stacks.
 * The value is a JSON {@link PendingContinuation}. Mirrors
 * `project-concurrency.ts`'s shape: a lazy fail-fast `Redis` singleton
 * (`maxRetriesPerRequest: 1`) with an `'error'` listener.
 *
 * Every operation swallows+logs Redis errors and fails open (register no-ops,
 * take returns `null`): a registry hiccup must never fail a real run, and the
 * concurrency deferral's fallback delayed retry still fires on its own delay, so
 * a lost registry entry only costs the *prompt* promotion, never the retry
 * itself. Single-worker MVP — a multi-worker deployment inherits
 * `project-concurrency`'s documented per-worker-lease caveat.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import type { TriggerPhase } from '../triggers/types.js';

const KEY_NS = 'swarm:pending-continuations:';

let redisInstance: Redis | null = null;

/**
 * A retained, concurrency-blocked continuation awaiting a freed project slot.
 * `jobId` is the delayed BullMQ retry job's id — the fallback retry that fires on
 * its own delay if no slot frees first, and the handle `promoteJobById` moves to
 * `waiting` when a slot does free.
 */
export type PendingContinuation = {
	jobId: string;
	taskId: string;
	phase: TriggerPhase;
	enqueuedAt: number;
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
function parseEntry(raw: string): PendingContinuation | undefined {
	try {
		const value = JSON.parse(raw) as Partial<PendingContinuation>;
		if (
			typeof value.jobId === 'string' &&
			typeof value.taskId === 'string' &&
			typeof value.phase === 'string' &&
			typeof value.enqueuedAt === 'number'
		) {
			return value as PendingContinuation;
		}
	} catch {
		// fall through
	}
	return undefined;
}

/**
 * Register (or replace) a project's pending continuation — `HSET` keyed on
 * `<taskId>:<phase>`, so a job re-deferred while already pending overwrites its
 * prior entry rather than stacking a second one. Idempotent; fails open.
 */
export async function registerPendingContinuation(
	projectId: string,
	entry: PendingContinuation,
): Promise<void> {
	try {
		await getRedis().hset(`${KEY_NS}${projectId}`, fieldFor(entry), JSON.stringify(entry));
	} catch (err) {
		logger.warn('pending-continuations: register failed (fallback retry still fires)', {
			projectId,
			error: String(err),
		});
	}
}

/**
 * Remove and return the project's oldest pending continuation by `enqueuedAt`
 * (FIFO), or `null` when none is pending. Malformed entries are dropped in
 * passing so a corrupt value can't wedge the registry. Fails open (returns
 * `null`) on a Redis error.
 */
export async function takeNextPendingContinuation(
	projectId: string,
): Promise<PendingContinuation | null> {
	const key = `${KEY_NS}${projectId}`;
	try {
		const redis = getRedis();
		const all = await redis.hgetall(key);
		let oldestField: string | undefined;
		let oldest: PendingContinuation | undefined;
		for (const [field, raw] of Object.entries(all)) {
			const parsed = parseEntry(raw);
			if (!parsed) {
				await redis.hdel(key, field);
				continue;
			}
			if (!oldest || parsed.enqueuedAt < oldest.enqueuedAt) {
				oldest = parsed;
				oldestField = field;
			}
		}
		if (!oldest || !oldestField) return null;
		await redis.hdel(key, oldestField);
		return oldest;
	} catch (err) {
		logger.warn('pending-continuations: take failed (fallback retry still fires)', {
			projectId,
			error: String(err),
		});
		return null;
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
 * Drop a project's whole pending-continuation registry (`DEL`) — the startup
 * reset (`src/worker/index.ts`), alongside `resetProjectSlot`. A previously
 * pending continuation still has its fallback delayed BullMQ retry in Redis, so
 * clearing the registry loses only the prompt-promote wake-up, never the retry.
 */
export async function clearPendingContinuations(projectId: string): Promise<void> {
	try {
		await getRedis().del(`${KEY_NS}${projectId}`);
	} catch (err) {
		logger.warn('pending-continuations: clear failed', { projectId, error: String(err) });
	}
}
