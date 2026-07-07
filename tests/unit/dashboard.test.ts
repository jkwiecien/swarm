import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDashboardApp } from '@/dashboard.js';

describe('swarm-dashboard API', () => {
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

	it('returns 404 for unknown routes when authenticated', async () => {
		const app = createDashboardApp({ token: 'test-token' });
		const res = await app.request('/nope', {
			headers: {
				Authorization: 'Bearer test-token',
			},
		});

		expect(res.status).toBe(404);
	});

	it('throws synchronously when initialized without a token', () => {
		vi.stubEnv('DASHBOARD_TOKEN', '');
		expect(() => createDashboardApp()).toThrow(/DASHBOARD_TOKEN is not configured/);
		expect(() => createDashboardApp({ token: '' })).toThrow(/DASHBOARD_TOKEN is not configured/);
	});
});
