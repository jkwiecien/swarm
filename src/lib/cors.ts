/**
 * CORS configuration for the dashboard API (`src/api/server.ts`).
 *
 * SWARM's recommended deployment is **same-origin**: one process serves the built
 * SPA and its API, so the browser never issues a cross-origin (pre-flighted)
 * request and CORS is inert. But the documented dev workflow runs the SPA on Vite
 * (`http://localhost:5173`) against the API on `API_PORT`
 * (`http://127.0.0.1:3101`) — a different origin — and every request carries the
 * session cookie via `credentials: 'include'` (`dashboard/src/lib/{auth,trpc}.ts`).
 * Browsers block credentialed cross-origin requests unless the server opts in, so
 * the dashboard must answer pre-flights with an explicit `Access-Control-Allow-
 * Origin` (never `*`, which is illegal alongside credentials) and
 * `Access-Control-Allow-Credentials: true`. Mirrors Cascade's `corsConfig.ts`,
 * minus its production hard-fail (SWARM is local-first and has no `NODE_ENV`).
 */

import { cors } from 'hono/cors';

/** The Vite dev-server origin the SPA is served from (see `dashboard/vite.config.ts`). */
export const DEV_SPA_ORIGIN = 'http://localhost:5173';

export interface CorsMiddlewareOptions {
	/**
	 * `CORS_ORIGIN` — a comma-separated allow-list of SPA origins, or undefined to
	 * fall back to the Vite dev origin.
	 */
	corsOriginEnv: string | undefined;
}

/**
 * Build the dashboard's credentialed CORS middleware.
 *
 * With `CORS_ORIGIN` set, only those (comma-separated) origins are allowed. Unset,
 * it defaults to the Vite dev origin so the documented `npm run dev` workflow works
 * out of the box; a same-origin deploy never pre-flights, so the default is inert
 * there. Credentials are always allowed (the session cookie rides every request),
 * which is why the origin is an explicit allow-list, never `*`.
 */
export function buildCorsMiddleware({
	corsOriginEnv,
}: CorsMiddlewareOptions): ReturnType<typeof cors> {
	const origins = corsOriginEnv
		?.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
	return cors({
		origin: origins?.length ? origins : DEV_SPA_ORIGIN,
		credentials: true,
	});
}
