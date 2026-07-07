import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { createDashboardApp } from '@/dashboard.js';
import { listAllProjectsFromDb } from '@/db/repositories/projectsRepository.js';

describe('swarm-dashboard API', () => {
	beforeEach(() => {
		vi.mocked(listAllProjectsFromDb).mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('serves /health check correctly without authentication', async () => {
		const app = createDashboardApp({ token: 'test-token' });
		const res = await app.request('/health');

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toEqual({
			status: 'ok',
			service: 'swarm-dashboard',
			timestamp: expect.any(String),
		});
	});

	it('serves tRPC ping query correctly over HTTP with valid authentication', async () => {
		const app = createDashboardApp({ token: 'test-token' });
		// GET is the standard tRPC HTTP protocol shape for query procedures
		const res = await app.request('/trpc/ping.ping', {
			headers: {
				Authorization: 'Bearer test-token',
			},
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toEqual({
			result: {
				data: {
					message: 'pong',
					timestamp: expect.any(String),
				},
			},
		});
	});

	it('returns 401 for tRPC request with no Authorization header', async () => {
		const app = createDashboardApp({ token: 'test-token' });
		const res = await app.request('/trpc/ping.ping');

		expect(res.status).toBe(401);
		const data = await res.json();
		expect(data).toEqual({
			error: 'Unauthorized',
			reason: 'Missing authorization header',
		});
	});

	it('returns 401 for tRPC request with incorrect token', async () => {
		const app = createDashboardApp({ token: 'test-token' });
		const res = await app.request('/trpc/ping.ping', {
			headers: {
				Authorization: 'Bearer wrong-token',
			},
		});

		expect(res.status).toBe(401);
		const data = await res.json();
		expect(data).toEqual({
			error: 'Unauthorized',
			reason: 'Invalid token',
		});
	});

	it('returns 400 for tRPC request with a malformed Authorization header', async () => {
		const app = createDashboardApp({ token: 'test-token' });
		const res = await app.request('/trpc/ping.ping', {
			headers: {
				Authorization: 'Basic test-token',
			},
		});

		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data).toEqual({
			error: 'Bad Request',
			reason: 'Invalid authorization header format',
		});
	});

	it('returns 404 for unknown routes when authenticated and no static assets exist', async () => {
		const app = createDashboardApp({ token: 'test-token', staticRoot: './non-existent-dist' });
		const res = await app.request('/nope', {
			headers: {
				Authorization: 'Bearer test-token',
			},
		});

		expect(res.status).toBe(404);
	});

	it('serves static assets without authentication', async () => {
		const app = createDashboardApp({ token: 'test-token', staticRoot: 'tests/fixtures/web-dist' });
		const res = await app.request('/assets/app.js');

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('javascript');
		const text = await res.text();
		expect(text).toContain('Hello from web-dist app.js fixture!');
	});

	it('falls back to index.html for client-side routing paths without authentication', async () => {
		const app = createDashboardApp({ token: 'test-token', staticRoot: 'tests/fixtures/web-dist' });
		const res = await app.request('/projects');

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('html');
		const text = await res.text();
		expect(text).toContain('Hello from web-dist fixture!');
	});

	it('still requires authorization for tRPC requests even when staticRoot exists', async () => {
		const app = createDashboardApp({ token: 'test-token', staticRoot: 'tests/fixtures/web-dist' });
		const res = await app.request('/trpc/ping.ping');

		expect(res.status).toBe(401);
	});

	it('returns 404 for unregistered non-API paths without authentication when staticRoot does not exist', async () => {
		const app = createDashboardApp({ token: 'test-token', staticRoot: './non-existent-dist' });
		const res = await app.request('/nope');

		expect(res.status).toBe(404);
	});

	it('throws synchronously when initialized without a token', () => {
		vi.stubEnv('DASHBOARD_TOKEN', '');
		expect(() => createDashboardApp()).toThrow(/DASHBOARD_TOKEN is not configured/);
		expect(() => createDashboardApp({ token: '' })).toThrow(/DASHBOARD_TOKEN is not configured/);
	});

	it('serves tRPC projects.list query correctly over HTTP with valid authentication', async () => {
		vi.mocked(listAllProjectsFromDb).mockResolvedValue([]);

		const app = createDashboardApp({ token: 'test-token' });
		const res = await app.request('/trpc/projects.list', {
			headers: {
				Authorization: 'Bearer test-token',
			},
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toEqual({
			result: {
				data: [],
			},
		});
		expect(listAllProjectsFromDb).toHaveBeenCalledTimes(1);
	});
});
