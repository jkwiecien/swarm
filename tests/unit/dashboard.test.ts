import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
	findProjectByBoardFromDb: vi.fn(),
	findProjectByIdFromDb: vi.fn(),
	upsertProjectToDb: vi.fn(),
	createProjectInDb: vi.fn(),
	deleteProjectFromDb: vi.fn(),
	listAllProjectsFromDb: vi.fn(),
	getProjectByIdFromDb: vi.fn(),
}));

vi.mock('@/identity/auth.js', () => ({
	verifyCredentials: vi.fn(),
	createSession: vi.fn(),
	resolveSession: vi.fn(),
	revokeSession: vi.fn(),
}));

import { createDashboardApp, SESSION_COOKIE_NAME } from '@/dashboard.js';
import { listAllProjectsFromDb } from '@/db/repositories/projectsRepository.js';
import {
	createSession,
	resolveSession,
	revokeSession,
	verifyCredentials,
} from '@/identity/auth.js';
import type { SwarmUser } from '@/identity/schema.js';

const user: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date('2020-01-01T00:00:00Z'),
	updatedAt: new Date('2020-01-01T00:00:00Z'),
};

const RAW_TOKEN = 'raw-session-token';

describe('swarm-dashboard API', () => {
	beforeEach(() => {
		// Keep the default-CORS assertions deterministic regardless of the ambient env.
		delete process.env.CORS_ORIGIN;
		vi.mocked(listAllProjectsFromDb).mockReset();
		vi.mocked(verifyCredentials).mockReset();
		vi.mocked(createSession).mockReset();
		vi.mocked(resolveSession).mockReset();
		vi.mocked(revokeSession).mockReset().mockResolvedValue(undefined);
	});

	describe('public routes', () => {
		it('serves /health without authentication', async () => {
			const app = createDashboardApp();
			const res = await app.request('/health');

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				status: 'ok',
				service: 'swarm-dashboard',
				timestamp: expect.any(String),
			});
		});

		it('serves the ping query without a session (it stays public)', async () => {
			const app = createDashboardApp();
			const res = await app.request('/trpc/ping.ping');

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				result: { data: { message: 'pong', timestamp: expect.any(String) } },
			});
		});
	});

	describe('authed procedures', () => {
		it('returns 401 for an authed procedure with no session cookie', async () => {
			const app = createDashboardApp();
			const res = await app.request('/trpc/projects.list');

			expect(res.status).toBe(401);
			expect(listAllProjectsFromDb).not.toHaveBeenCalled();
		});

		it('serves an authed procedure when the session cookie resolves to a user', async () => {
			vi.mocked(resolveSession).mockResolvedValue(user);
			vi.mocked(listAllProjectsFromDb).mockResolvedValue([]);

			const app = createDashboardApp();
			const res = await app.request('/trpc/projects.list', {
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${RAW_TOKEN}` },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ result: { data: [] } });
			expect(resolveSession).toHaveBeenCalledWith(RAW_TOKEN);
			expect(listAllProjectsFromDb).toHaveBeenCalledTimes(1);
		});

		it('returns 401 when the session cookie no longer resolves to a user', async () => {
			vi.mocked(resolveSession).mockResolvedValue(undefined);

			const app = createDashboardApp();
			const res = await app.request('/trpc/projects.list', {
				headers: { Cookie: `${SESSION_COOKIE_NAME}=stale` },
			});

			expect(res.status).toBe(401);
			expect(listAllProjectsFromDb).not.toHaveBeenCalled();
		});
	});

	describe('POST /auth/login', () => {
		it('sets an HTTP-only session cookie and returns the user (never the token)', async () => {
			vi.mocked(verifyCredentials).mockResolvedValue(user);
			vi.mocked(createSession).mockResolvedValue({
				token: RAW_TOKEN,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			});

			const app = createDashboardApp();
			const res = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: 'ada@example.com', password: 'hunter2' }),
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			// Dates serialize to ISO strings over JSON, so match the identity fields.
			expect(body.user).toMatchObject({
				id: user.id,
				identifier: user.identifier,
				displayName: user.displayName,
				instanceAdmin: user.instanceAdmin,
			});
			expect(JSON.stringify(body)).not.toContain(RAW_TOKEN);

			const setCookie = res.headers.get('set-cookie') ?? '';
			expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${RAW_TOKEN}`);
			expect(setCookie).toMatch(/HttpOnly/i);
			expect(setCookie).toMatch(/SameSite=Strict/i);
		});

		it('marks the cookie Secure off localhost but not on localhost', async () => {
			vi.mocked(verifyCredentials).mockResolvedValue(user);
			vi.mocked(createSession).mockResolvedValue({
				token: RAW_TOKEN,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			});

			const app = createDashboardApp();
			const body = JSON.stringify({ identifier: 'ada@example.com', password: 'hunter2' });
			const headers = { 'Content-Type': 'application/json' };

			const remote = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers,
				body,
			});
			expect(remote.headers.get('set-cookie') ?? '').toMatch(/Secure/i);

			const local = await app.request('http://localhost/auth/login', {
				method: 'POST',
				headers,
				body,
			});
			expect(local.headers.get('set-cookie') ?? '').not.toMatch(/Secure/i);
		});

		it('returns 401 with no cookie for invalid credentials', async () => {
			vi.mocked(verifyCredentials).mockResolvedValue(undefined);

			const app = createDashboardApp();
			const res = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: 'ada@example.com', password: 'wrong' }),
			});

			expect(res.status).toBe(401);
			expect(res.headers.get('set-cookie')).toBeNull();
			expect(createSession).not.toHaveBeenCalled();
		});

		it('returns 400 for a malformed body', async () => {
			const app = createDashboardApp();
			const res = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: 'ada@example.com' }),
			});

			expect(res.status).toBe(400);
			expect(verifyCredentials).not.toHaveBeenCalled();
		});
	});

	describe('POST /auth/logout', () => {
		it('revokes the session and clears the cookie', async () => {
			const app = createDashboardApp();
			const res = await app.request('http://example.com/auth/logout', {
				method: 'POST',
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${RAW_TOKEN}` },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
			expect(revokeSession).toHaveBeenCalledWith(RAW_TOKEN);

			const setCookie = res.headers.get('set-cookie') ?? '';
			expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
			expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
		});

		it('is a no-op (still 200) with no session cookie', async () => {
			const app = createDashboardApp();
			const res = await app.request('http://example.com/auth/logout', { method: 'POST' });

			expect(res.status).toBe(200);
			expect(revokeSession).not.toHaveBeenCalled();
		});
	});

	describe('CORS (credentialed, for the separate-origin dev setup)', () => {
		it('answers a pre-flight from the Vite dev origin with credentialed CORS headers', async () => {
			// Reproduces the reviewer's case: SPA on http://localhost:5173, API on
			// DASHBOARD_PORT. The credentialed POST /auth/login is pre-flighted.
			const app = createDashboardApp();
			const res = await app.request('http://127.0.0.1:3101/auth/login', {
				method: 'OPTIONS',
				headers: {
					Origin: 'http://localhost:5173',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'content-type',
				},
			});

			expect(res.status).toBeLessThan(300);
			expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
			expect(res.headers.get('access-control-allow-credentials')).toBe('true');
			// Never the wildcard — illegal alongside credentials.
			expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
		});

		it('reflects the configured CORS_ORIGIN allow-list and rejects others', async () => {
			const app = createDashboardApp({ corsOrigin: 'https://dash.example.com' });

			const allowed = await app.request('http://api.example.com/auth/login', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://dash.example.com',
					'Access-Control-Request-Method': 'POST',
				},
			});
			expect(allowed.headers.get('access-control-allow-origin')).toBe('https://dash.example.com');
			expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

			const other = await app.request('http://api.example.com/auth/login', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://evil.example.com',
					'Access-Control-Request-Method': 'POST',
				},
			});
			expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
		});

		it('exposes credentialed CORS on /trpc as well', async () => {
			const app = createDashboardApp();
			const res = await app.request('http://127.0.0.1:3101/trpc/projects.list', {
				method: 'OPTIONS',
				headers: {
					Origin: 'http://localhost:5173',
					'Access-Control-Request-Method': 'POST',
				},
			});

			expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
			expect(res.headers.get('access-control-allow-credentials')).toBe('true');
		});
	});

	describe('static assets', () => {
		it('serves static assets without authentication', async () => {
			const app = createDashboardApp({ staticRoot: 'tests/fixtures/web-dist' });
			const res = await app.request('/assets/app.js');

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toContain('javascript');
			expect(await res.text()).toContain('Hello from web-dist app.js fixture!');
		});

		it('falls back to index.html for client-side routes without authentication', async () => {
			const app = createDashboardApp({ staticRoot: 'tests/fixtures/web-dist' });
			const res = await app.request('/login');

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toContain('html');
			expect(await res.text()).toContain('Hello from web-dist fixture!');
		});

		it('returns 404 for unknown routes when no static assets exist', async () => {
			const app = createDashboardApp({ staticRoot: './non-existent-dist' });
			const res = await app.request('/nope');

			expect(res.status).toBe(404);
		});
	});
});
