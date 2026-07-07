/**
 * Dashboard API entry point — a self-hosted single-process Hono app
 * (ai/ARCHITECTURE.md). Exposes /health and mounts tRPC at /trpc. Unlike
 * Cascade's split cloud deployment (separate API + Cloudflare Pages frontend), SWARM runs
 * one process for its local-first, single-user scope.
 */
import { serve } from '@hono/node-server';
import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';

import { appRouter } from './api/router.js';
import { configureLogger, logger } from './lib/logger.js';

export function createDashboardApp(options: { token?: string } = {}): Hono {
	const app = new Hono();

	const token = options.token ?? process.env.DASHBOARD_TOKEN;
	if (!token) {
		throw new Error(
			'DASHBOARD_TOKEN is not configured. Generate one in .env by running:\n' +
				"node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"",
		);
	}

	app.get('/health', (c) =>
		c.json({
			status: 'ok',
			service: 'swarm-dashboard',
			timestamp: new Date().toISOString(),
		}),
	);

	app.use(
		'*',
		bearerAuth({
			token,
			noAuthenticationHeader: {
				message: { error: 'Unauthorized', reason: 'Missing authorization header' },
			},
			invalidAuthenticationHeader: {
				message: { error: 'Bad Request', reason: 'Invalid authorization header format' },
			},
			invalidToken: {
				message: { error: 'Unauthorized', reason: 'Invalid token' },
			},
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
	const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
		logger.info('swarm-dashboard: listening', { port, hostname: '127.0.0.1' });
	});
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => server.close(() => process.exit(0)));
	}
}
