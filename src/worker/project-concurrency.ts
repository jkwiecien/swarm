import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const KEY_NS = 'swarm:project-slots:';

let redisInstance: Redis | null = null;

export type SlotAcquisition = { acquired: false } | { acquired: true; tracked: boolean };

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('project-concurrency: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Atomically reserve one of a project's slots. Redis failures fail open because
 * the worker-global BullMQ concurrency still bounds total load.
 */
export async function acquireProjectSlot(
	projectId: string,
	limit: number,
): Promise<SlotAcquisition> {
	const key = `${KEY_NS}${projectId}`;
	try {
		const redis = getRedis();
		const count = await redis.incr(key);
		if (count > limit) {
			await redis.decr(key);
			logger.debug('project-concurrency: at limit, deferring', { projectId, count, limit });
			return { acquired: false };
		}
		return { acquired: true, tracked: true };
	} catch (err) {
		logger.error('project-concurrency: Redis error — failing open (running uncapped)', {
			projectId,
			error: String(err),
		});
		return { acquired: true, tracked: false };
	}
}

export async function releaseProjectSlot(projectId: string): Promise<void> {
	const key = `${KEY_NS}${projectId}`;
	try {
		const redis = getRedis();
		const count = await redis.decr(key);
		if (count < 0) await redis.set(key, '0');
	} catch (err) {
		logger.warn('project-concurrency: release failed', { projectId, error: String(err) });
	}
}

/**
 * Clear counters leaked by a crashed single-worker process. A multi-worker
 * deployment must replace this startup reset with expiring per-worker leases.
 */
export async function resetProjectSlot(projectId: string): Promise<void> {
	try {
		await getRedis().del(`${KEY_NS}${projectId}`);
	} catch (err) {
		logger.warn('project-concurrency: reset failed', { projectId, error: String(err) });
	}
}
