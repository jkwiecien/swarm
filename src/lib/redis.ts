/**
 * Redis URL → BullMQ connection options, mirroring Cascade's `src/utils/redis.ts`
 * so producer (router) and consumer (worker) parse `REDIS_URL` one way.
 */

import type { ConnectionOptions } from 'bullmq';

export function parseRedisUrl(url: string): ConnectionOptions {
	const parsed = new URL(url);
	return {
		host: parsed.hostname,
		port: Number(parsed.port) || 6379,
		password: parsed.password || undefined,
		// BullMQ's blocking consumer connections require this to be null (commands
		// must block indefinitely rather than error out); harmless for producers.
		maxRetriesPerRequest: null,
	};
}
