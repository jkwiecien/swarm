import { describe, expect, it } from 'vitest';

import { createDashboardApp } from '@/dashboard.js';

describe('swarm-dashboard API', () => {
	it('serves /health check correctly', async () => {
		const app = createDashboardApp();
		const res = await app.request('/health');

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toEqual({
			status: 'ok',
			service: 'swarm-dashboard',
			timestamp: expect.any(String),
		});
	});

	it('serves tRPC ping query correctly over HTTP', async () => {
		const app = createDashboardApp();
		// GET is the standard tRPC HTTP protocol shape for query procedures
		const res = await app.request('/trpc/ping.ping');

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

	it('returns 404 for unknown routes', async () => {
		const app = createDashboardApp();
		const res = await app.request('/nope');

		expect(res.status).toBe(404);
	});
});
