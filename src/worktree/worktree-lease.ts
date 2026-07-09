import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const KEY_NS = 'swarm:worktree-lease:';
// Generous on purpose: must outlive the longest realistic single-phase agent
// run. A crash before cleanup()'s release leaves this to expire naturally
// rather than permanently marking the worktree "in use" — the exact case this
// issue is about (a worker crash mid-phase). Not refreshed/heartbeated: every
// phase's own `finally` releases it well before this fires on the happy path.
const LEASE_TTL_SEC = 4 * 60 * 60; // 4h

let redisInstance: Redis | null = null;

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('worktree lease: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

export function buildLeaseKey(projectId: string, taskId: string): string {
	return `${projectId}:${taskId}`;
}

/** Best-effort; never throws. Logs and no-ops on a Redis error — losing a lease claim just means a later sweep might (rarely) skip a worktree it didn't need to. */
export async function claimWorktreeLease(projectId: string, taskId: string): Promise<void> {
	const key = buildLeaseKey(projectId, taskId);
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().set(namespacedKey, '1', 'EX', LEASE_TTL_SEC);
		logger.debug('worktree lease: claimed lease for task', { projectId, taskId });
	} catch (err) {
		logger.error('worktree lease: claim failed', { projectId, taskId, error: String(err) });
	}
}

/** Best-effort; never throws — same posture as releaseReviewDispatch (TTL is the backstop). */
export async function releaseWorktreeLease(projectId: string, taskId: string): Promise<void> {
	const key = buildLeaseKey(projectId, taskId);
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().del(namespacedKey);
		logger.debug('worktree lease: released lease for task', { projectId, taskId });
	} catch (err) {
		logger.warn('worktree lease: release failed (TTL will reap)', {
			projectId,
			taskId,
			error: String(err),
		});
	}
}

/**
 * Fails CLOSED the opposite way from the dispatch dedups: on a Redis error this
 * returns `true` (treat as leased/in-flight), because for retention the unsafe
 * outcome is deleting something still in use, not skipping something that's
 * actually free. A prune that's overly conservative this round just retries
 * next sweep.
 */
export async function isWorktreeLeased(projectId: string, taskId: string): Promise<boolean> {
	const key = buildLeaseKey(projectId, taskId);
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		const exists = await getRedis().exists(namespacedKey);
		return exists === 1;
	} catch (err) {
		logger.error('worktree lease: check failed — failing closed (treating as leased)', {
			projectId,
			taskId,
			error: String(err),
		});
		return true;
	}
}
