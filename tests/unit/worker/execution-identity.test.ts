import { beforeEach, describe, expect, it, vi } from 'vitest';

const { acquireSession, heartbeat, releaseSession, resolveHeartbeatTtlMs } = vi.hoisted(() => ({
	acquireSession: vi.fn(),
	heartbeat: vi.fn(),
	releaseSession: vi.fn(),
	resolveHeartbeatTtlMs: vi.fn(),
}));

vi.mock('@/identity/worker-session-service.js', () => ({
	acquireSession,
	heartbeat,
	releaseSession,
	resolveHeartbeatTtlMs,
}));

import { acquireWorkerExecutionSession } from '@/worker/execution-identity.js';

describe('worker execution identity', () => {
	beforeEach(() => {
		acquireSession.mockReset();
		heartbeat.mockReset();
		releaseSession.mockReset();
		resolveHeartbeatTtlMs.mockReset();
		resolveHeartbeatTtlMs.mockReturnValue(60_000);
	});

	it('keeps the raw credential inside a fenced session handle', async () => {
		acquireSession.mockResolvedValue({
			session: {
				id: '11111111-1111-4111-8111-111111111111',
				workerId: '22222222-2222-4222-8222-222222222222',
				fencingToken: 9,
			},
			fencingToken: 9,
		});
		heartbeat.mockResolvedValue(true);
		releaseSession.mockResolvedValue(true);

		const session = await acquireWorkerExecutionSession('raw-worker-secret');

		expect(session.identity).toEqual({
			workerId: '22222222-2222-4222-8222-222222222222',
			sessionId: '11111111-1111-4111-8111-111111111111',
			fencingToken: 9,
			heartbeatTtlMs: 60_000,
		});
		expect(session.identity).not.toHaveProperty('credential');
		expect(await session.heartbeat()).toBe(true);
		expect(await session.release()).toBe(true);
		expect(acquireSession).toHaveBeenCalledWith('raw-worker-secret', 60_000);
		expect(heartbeat).toHaveBeenCalledWith('raw-worker-secret', 9, 60_000);
		expect(releaseSession).toHaveBeenCalledWith('raw-worker-secret', 9);
	});
});
