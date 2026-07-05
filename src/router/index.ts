/**
 * Router entry point — serves the GitHub webhook receiver over HTTP.
 *
 * All the request logic lives in `webhook-receiver.ts` (testable without a live
 * server); this module is just the process boundary: build the app, bind the
 * port, and shut down cleanly. Verified events are enqueued onto BullMQ at the
 * `enqueue.ts` seam (producer in `queue/producer.ts`).
 */

import { serve } from '@hono/node-server';

import { logger } from '../lib/logger.js';
import { closeQueue } from '../queue/producer.js';
import { createWebhookApp } from './webhook-receiver.js';

const port = Number(process.env.PORT ?? 3000);

const app = createWebhookApp();
const server = serve({ fetch: app.fetch, port }, () => {
	logger.info('swarm-router: listening', { port });
});

// Docker sends SIGTERM on `compose down`/`stop`; close the listener so the
// container stops promptly instead of being killed after the grace period.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		// Stop accepting requests, then drain the BullMQ producer connection so the
		// process exits instead of hanging on an open Redis socket.
		server.close(() => {
			void closeQueue().then(
				() => process.exit(0),
				(err) => {
					logger.error('Producer queue close failed', {
						error: err instanceof Error ? err.message : String(err),
					});
					process.exit(1);
				},
			);
		});
	});
}
