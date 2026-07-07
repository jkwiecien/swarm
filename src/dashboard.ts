/**
 * Dashboard API entry point — a self-hosted single-process Hono app
 * (ai/ARCHITECTURE.md). Exposes /health and mounts tRPC at /trpc. Unlike
 * Cascade's split cloud deployment (separate API + Cloudflare Pages frontend), SWARM runs
 * one process for its local-first, single-user scope.
 */
import { serve } from '@hono/node-server';
import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';

import { appRouter } from './api/router.js';
import { configureLogger, logger } from './lib/logger.js';

export function createDashboardApp(): Hono {
	const app = new Hono();

	app.get('/health', (c) =>
		c.json({
			status: 'ok',
			service: 'swarm-dashboard',
			timestamp: new Date().toISOString(),
		}),
	);

	app.use('/trpc/*', trpcServer({ endpoint: '/trpc', router: appRouter }));

	return app;
}

// Entrypoint bootstrap — only when executed directly, so tests can import the
// factory without binding a port (mirrors src/router/index.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
	configureLogger({ component: 'dashboard' });
	const port = Number(process.env.DASHBOARD_PORT ?? 3101);
	const app = createDashboardApp();
	const server = serve({ fetch: app.fetch, port }, () => {
		logger.info('swarm-dashboard: listening', { port });
	});
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => server.close(() => process.exit(0)));
	}
}
