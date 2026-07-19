import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { buildCorsMiddleware, DEV_SPA_ORIGIN } from '@/lib/cors.js';

/**
 * Send a cross-origin GET to a minimal app carrying the given CORS middleware and
 * return the response, so tests can inspect the `Access-Control-*` headers Hono's
 * `cors()` sets. Mirrors Cascade's `corsConfig.test.ts` helper.
 */
async function fetchWithOrigin(
	middleware: ReturnType<typeof buildCorsMiddleware>,
	origin: string,
): Promise<Response> {
	const app = new Hono();
	app.use('*', middleware);
	app.get('/test', (c) => c.text('ok'));
	return app.request('/test', { method: 'GET', headers: { Origin: origin } });
}

describe('buildCorsMiddleware', () => {
	describe('when CORS_ORIGIN is set', () => {
		it('allows a single configured origin with credentials', async () => {
			const mw = buildCorsMiddleware({ corsOriginEnv: 'https://dash.example.com' });
			const res = await fetchWithOrigin(mw, 'https://dash.example.com');

			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dash.example.com');
			expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
		});

		it('allows any of several comma-separated origins', async () => {
			const mw = buildCorsMiddleware({
				corsOriginEnv: 'https://app.example.com,https://dev.example.com',
			});
			const res = await fetchWithOrigin(mw, 'https://dev.example.com');
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dev.example.com');
		});

		it('does not reflect an origin outside the list', async () => {
			const mw = buildCorsMiddleware({ corsOriginEnv: 'https://dash.example.com' });
			const res = await fetchWithOrigin(mw, 'https://evil.example.com');
			// Hono's cors() emits no allow-origin header when the origin isn't permitted.
			expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example.com');
		});

		it('trims whitespace around comma-separated origins', async () => {
			const mw = buildCorsMiddleware({
				corsOriginEnv: '  https://app.example.com ,  https://dev.example.com  ',
			});
			const res = await fetchWithOrigin(mw, 'https://app.example.com');
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
		});
	});

	describe('when CORS_ORIGIN is unset or empty', () => {
		it('defaults to the Vite dev origin', async () => {
			const mw = buildCorsMiddleware({ corsOriginEnv: undefined });
			const res = await fetchWithOrigin(mw, DEV_SPA_ORIGIN);

			expect(res.headers.get('Access-Control-Allow-Origin')).toBe(DEV_SPA_ORIGIN);
			expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
		});

		it('treats a whitespace-/comma-only value as unset (falls back to the dev origin)', async () => {
			const mw = buildCorsMiddleware({ corsOriginEnv: ' , ' });
			const res = await fetchWithOrigin(mw, DEV_SPA_ORIGIN);
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe(DEV_SPA_ORIGIN);
		});

		it('never allows the wildcard (illegal alongside credentials)', async () => {
			const mw = buildCorsMiddleware({ corsOriginEnv: undefined });
			const res = await fetchWithOrigin(mw, 'https://somewhere.example.com');
			expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
		});
	});
});
