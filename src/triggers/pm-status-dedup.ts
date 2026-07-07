/**
 * PM status-dispatch deduplication, Redis-backed — mirrors
 * `review-dispatch-dedup.ts`'s pattern, for a gap that dedup opened up rather
 * than closed.
 *
 * `GitHubProjectsRouterAdapter.isStatusChange` accepts the `reordered` action
 * so a Kanban board's actual drag-and-drop (which fires `reordered`, not
 * `edited` — see that file's comment) reaches the pipeline. But `reordered`
 * also fires on a *pure* within-column reorder that carries no Status change
 * at all — GitHub's payload has no `changes.field_value` to filter on there,
 * so `pm-status.ts`'s `matches` gate can't rule that case out the way it can
 * for `edited`. Without this guard, every such reorder would re-dispatch
 * whatever phase the item's current Status already started — a duplicate
 * Claude Code run for an in-progress task, or a duplicate plan comment.
 *
 * Unlike `review-dispatch-dedup.ts`'s "claim once, ever" semantics (a PR+SHA is
 * immutable), this tracks the *last dispatched status* per item and skips only
 * when the freshly re-read status matches it. A genuine return to a status —
 * moved away and intentionally moved back to Planning, say — still dispatches;
 * only a same-status no-op (reorder, or a duplicate webhook delivery) is
 * skipped.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const KEY_NS = 'swarm:pm-status-dedup:';

let redisInstance: Redis | null = null;

/**
 * Lazy singleton, same rationale and `maxRetriesPerRequest` override as
 * `review-dispatch-dedup.ts`'s `getRedis`: pays the connection cost only once
 * a dispatch decision is actually needed, and fails fast (rather than hanging)
 * when Redis is unreachable so the call site can fail closed promptly.
 */
function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('pm-status dedup: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Whether the pm-status trigger should dispatch a phase for `itemNodeId` given
 * its freshly re-read `statusId`. Returns `false` when the last status
 * dispatched for this exact item was already `statusId` — updates the stored
 * value and returns `true` for any different status, including the item's
 * very first dispatch (no stored value yet).
 *
 * Fails closed on Redis errors, matching `review-dispatch-dedup.ts`'s posture:
 * skipping a legitimate dispatch is cheaper than risking a duplicate one, and
 * the board keeps generating webhook events as the user keeps interacting
 * with it, so a transient failure isn't a permanently stuck item — the next
 * event gets another chance once Redis recovers.
 */
export async function shouldDispatchForStatus(
	itemNodeId: string,
	statusId: string,
): Promise<boolean> {
	const key = `${KEY_NS}${itemNodeId}`;
	try {
		const previous = await getRedis().get(key);
		if (previous === statusId) {
			logger.info('pm-status dedup: same status as last dispatch, skipping', {
				itemNodeId,
				statusId,
			});
			return false;
		}
		await getRedis().set(key, statusId);
		return true;
	} catch (err) {
		logger.error('pm-status dedup: Redis call failed — failing closed', {
			itemNodeId,
			statusId,
			error: String(err),
		});
		return false;
	}
}
