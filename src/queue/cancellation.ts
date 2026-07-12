/**
 * User-initiated run cancellation — the durable, cross-process hand-off behind
 * the dashboard's "Terminate" action (issue #166).
 *
 * The dashboard and worker are separate host processes, so the dashboard can't
 * reach into the worker to kill an in-flight agent (and must never trust a PID
 * the browser hands it). Instead it records the intent in Redis, keyed by the
 * immutable SWARM run id, and notifies the worker:
 *
 *   - A **durable set** (`CANCELLATION_SET_KEY`) of run ids a user asked to
 *     terminate. Durable so a cancellation requested while the worker is between
 *     jobs — or restarting — is still honoured when the run is next examined
 *     ({@link isRunCancellationRequested}), rather than lost with a fired-once
 *     notification.
 *   - A **pub/sub notification** (`CANCELLATION_CHANNEL`) so a worker already
 *     running the matching agent aborts it *promptly* instead of only noticing
 *     on the next poll.
 *
 * Keying on the run id (not the task id) is deliberate: a task can be retried
 * into a *new* run, and a cancellation aimed at the old run must never terminate
 * the retry. The worker clears the entry once it has acted on it (and the
 * `retryNow` mutation clears it before re-running), so a re-run of a terminated
 * run starts clean.
 *
 * Own lazy ioredis client per process, mirroring `project-concurrency.ts` — the
 * dashboard publishes, the worker subscribes, both against the one shared Redis.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

/** The durable set of run ids a user asked to terminate. */
const CANCELLATION_SET_KEY = 'swarm:run-cancellations';
/** Pub/sub channel carrying a just-requested run id for prompt worker abort. */
const CANCELLATION_CHANNEL = 'swarm:run-cancel';

/** The `error`/message a user-terminated run records — its terminal reason. */
export const USER_TERMINATION_MESSAGE = 'Run terminated by user from the dashboard.';

let redisInstance: Redis | null = null;

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('run-cancellation: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Record a user's intent to terminate `runId` and notify any worker running it.
 * The set write is the durable source of truth; the publish is best-effort
 * prompt notification (a worker not currently subscribed still honours the set
 * entry when it next examines the run). Throws if the durable write fails — the
 * caller (the `terminate` mutation) surfaces that so the user knows the request
 * didn't land.
 */
export async function requestRunCancellation(runId: string): Promise<void> {
	const redis = getRedis();
	await redis.sadd(CANCELLATION_SET_KEY, runId);
	try {
		await redis.publish(CANCELLATION_CHANNEL, runId);
	} catch (err) {
		// The durable set entry already landed; a failed notification only costs
		// promptness (the worker still catches it on its own start-check), so log
		// and continue rather than failing the whole termination.
		logger.warn('run-cancellation: failed to publish cancellation notification', {
			runId,
			error: String(err),
		});
	}
}

/**
 * Whether a user asked to terminate `runId`. Read by the worker at run start and
 * when a run fails, to tell a user-termination abort apart from a worker-shutdown
 * one. Fails safe: a Redis read error resolves `false` (treat as not cancelled)
 * so a transient blip never spuriously terminates a healthy run.
 */
export async function isRunCancellationRequested(runId: string): Promise<boolean> {
	try {
		return (await getRedis().sismember(CANCELLATION_SET_KEY, runId)) === 1;
	} catch (err) {
		logger.warn('run-cancellation: failed to read cancellation state — assuming not cancelled', {
			runId,
			error: String(err),
		});
		return false;
	}
}

/**
 * Clear `runId`'s cancellation entry once it has been acted on (the worker after
 * terminating the run, `retryNow` before re-running it), so a later re-run of the
 * same row isn't terminated by a stale request. Best-effort: a failed clear only
 * risks a redundant no-op abort of an already-terminal run, so log and continue.
 */
export async function clearRunCancellation(runId: string): Promise<void> {
	try {
		await getRedis().srem(CANCELLATION_SET_KEY, runId);
	} catch (err) {
		logger.warn('run-cancellation: failed to clear cancellation state', {
			runId,
			error: String(err),
		});
	}
}

/**
 * Subscribe to prompt cancellation notifications, invoking `onCancel(runId)` for
 * each one. ioredis requires a dedicated connection in subscriber mode (it can't
 * also run normal commands), so this duplicates the shared client. Returns an
 * async closer the worker calls on shutdown. Best-effort delivery: the durable
 * set (`isRunCancellationRequested`) is the guarantee; this is the low-latency
 * path on top of it.
 */
export function subscribeToRunCancellations(onCancel: (runId: string) => void): {
	close: () => Promise<void>;
} {
	const subscriber = getRedis().duplicate();
	subscriber.on('error', (err) => {
		logger.warn('run-cancellation: subscriber connection error', { error: String(err) });
	});
	subscriber.subscribe(CANCELLATION_CHANNEL).catch((err) => {
		logger.error('run-cancellation: failed to subscribe to cancellation channel', {
			error: String(err),
		});
	});
	subscriber.on('message', (channel, message) => {
		if (channel === CANCELLATION_CHANNEL && message) onCancel(message);
	});
	return {
		close: async () => {
			try {
				await subscriber.quit();
			} catch {
				subscriber.disconnect();
			}
		},
	};
}

/** Close the shared client — called from process shutdown so the socket frees. */
export async function closeRunCancellationRedis(): Promise<void> {
	if (redisInstance) {
		try {
			await redisInstance.quit();
		} catch {
			redisInstance.disconnect();
		}
		redisInstance = null;
	}
}
