/**
 * Router entry point — serves the GitHub webhook receiver over HTTP.
 *
 * All the request logic lives in `webhook-receiver.ts` (testable without a live
 * server); this module is just the process boundary: build the app, bind the
 * port, and shut down cleanly. Enqueuing onto BullMQ is deferred to the trigger
 * registry / worker phase — see `enqueue.ts`.
 */

import { serve } from '@hono/node-server';

import { logger } from '../lib/logger.js';
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
		server.close(() => process.exit(0));
	});
}
