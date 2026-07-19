/**
 * Dashboard API entry point — a self-hosted single-process Hono app
 * (ai/ARCHITECTURE.md). Exposes /health, the /auth/login + /auth/logout session
 * endpoints, and mounts tRPC at /trpc. Unlike Cascade's split cloud deployment
 * (separate API + Cloudflare Pages frontend), SWARM runs one process for its
 * local-first scope.
 *
 * Access control is per-user session auth (#281 task 2), not the old shared
 * `DASHBOARD_TOKEN` bearer secret: a user logs in with their password, gets an
 * opaque session delivered as an HTTP-only cookie, and every `/trpc/*` procedure
 * except `ping` runs as `authedProcedure` — the tRPC context resolves the caller
 * from that cookie. The raw token is never returned in a body or logged; only its
 * hash is stored (`src/identity/auth.ts`).
 */
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { trpcServer } from '@hono/trpc-server';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import { z } from 'zod';

import { appRouter } from './api/router.js';
import type { TrpcContext } from './api/trpc.js';
import {
	createSession,
	resolveSession,
	revokeSession,
	verifyCredentials,
} from './identity/auth.js';
import { configureLogger, logger } from './lib/logger.js';

/** Name of the HTTP-only cookie carrying the opaque session token. */
export const SESSION_COOKIE_NAME = 'swarm_session';

const LoginInputSchema = z.object({
	identifier: z.string().min(1),
	password: z.string().min(1),
});

/**
 * Whether the request targets a loopback host. The session cookie is marked
 * `Secure` for everything else (a Secure cookie is dropped by browsers over
 * plain HTTP, which is exactly the localhost dev case we must not break). The
 * host comes from the request URL, which `@hono/node-server` builds from the
 * incoming `Host` header.
 */
function isLocalhostRequest(c: Context): boolean {
	let hostname: string;
	try {
		hostname = new URL(c.req.url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname === '[::1]'
	);
}

/** Shared cookie attributes for the session cookie — HTTP-only, SameSite=Strict. */
function sessionCookieOptions(c: Context): CookieOptions {
	return {
		httpOnly: true,
		sameSite: 'Strict',
		secure: !isLocalhostRequest(c),
		path: '/',
	};
}

export function createDashboardApp(options: { staticRoot?: string } = {}): Hono {
	const app = new Hono();

	app.get('/health', (c) =>
		c.json({
			status: 'ok',
			service: 'swarm-dashboard',
			timestamp: new Date().toISOString(),
		}),
	);

	// Log in: verify credentials, mint a session, and deliver the opaque token as
	// an HTTP-only cookie. The body carries only the public SwarmUser (no token,
	// no hash) so the SPA can prime its "who am I" state.
	app.post('/auth/login', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Bad Request', reason: 'Expected a JSON body' }, 400);
		}
		const parsed = LoginInputSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: 'Bad Request', reason: 'identifier and password are required' }, 400);
		}

		const user = await verifyCredentials(parsed.data.identifier, parsed.data.password);
		if (!user) {
			return c.json({ error: 'Unauthorized', reason: 'Invalid credentials' }, 401);
		}

		const session = await createSession(user.id);
		setCookie(c, SESSION_COOKIE_NAME, session.token, {
			...sessionCookieOptions(c),
			expires: session.expiresAt,
		});
		return c.json({ user });
	});

	// Log out: revoke the session server-side and clear the cookie. Idempotent —
	// a request with no (or an unknown) session still clears the cookie and 200s.
	app.post('/auth/logout', async (c) => {
		const token = getCookie(c, SESSION_COOKIE_NAME);
		if (token) {
			await revokeSession(token);
		}
		deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(c));
		return c.json({ ok: true });
	});

	app.use(
		'/trpc/*',
		trpcServer({
			endpoint: '/trpc',
			router: appRouter,
			createContext: async (_opts, c): Promise<TrpcContext> => {
				const token = getCookie(c, SESSION_COOKIE_NAME);
				const user = token ? await resolveSession(token) : undefined;
				return { user: user ?? null };
			},
		}),
	);

	const staticRoot = options.staticRoot ?? './web/dist';
	if (existsSync(`${staticRoot}/index.html`)) {
		app.use('/assets/*', serveStatic({ root: staticRoot }));
		app.get('*', serveStatic({ root: staticRoot, rewriteRequestPath: () => '/index.html' }));
	}

	return app;
}

// Entrypoint bootstrap — only when executed directly, so tests can import the
// factory without binding a port (mirrors src/router/index.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
	configureLogger({ component: 'dashboard' });
	const port = Number(process.env.DASHBOARD_PORT ?? 3101);
	const app = createDashboardApp();
	const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
		logger.debug('swarm-dashboard: listening', { port, hostname: '127.0.0.1' });
	});
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => server.close(() => process.exit(0)));
	}
}
