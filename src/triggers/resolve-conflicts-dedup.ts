import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

let redis: Redis | undefined;
function client(): Redis {
	if (!redis) {
		redis = new Redis({ ...parseRedisUrl(requireEnv('REDIS_URL')), maxRetriesPerRequest: 1 });
		redis.on('error', (error) =>
			logger.warn('resolve-conflicts dedup: Redis error', { error: String(error) }),
		);
	}
	return redis;
}

/** One resolution run per PR/head/base state. Fails closed to prevent destructive duplicate merges. */
export async function claimConflictResolution(key: string): Promise<boolean> {
	try {
		return (
			(await client().set(`swarm:resolve-conflicts:${key}`, '1', 'EX', 24 * 60 * 60, 'NX')) === 'OK'
		);
	} catch (error) {
		logger.error('resolve-conflicts dedup: claim failed — skipping', { key, error: String(error) });
		return false;
	}
}
