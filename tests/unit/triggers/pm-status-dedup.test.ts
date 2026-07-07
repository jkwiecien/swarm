import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches a real Redis — capture the constructor and the
// set() calls the helper makes. Hoisted so the vi.mock factory (itself hoisted
// above imports) can reference them.
const { RedisMock, set, on } = vi.hoisted(() => {
	const set = vi.fn();
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ set, on }));
	return { RedisMock, set, on };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

// The helper holds a lazy Redis singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions don't cross-pollute.
beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	set.mockReset();
	set.mockResolvedValue(null);
	on.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

const NS = 'swarm:pm-status-dedup:';

describe('shouldDispatchForStatus', () => {
	it('dispatches (returns true) and stores the status on first dispatch for an item', async () => {
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		const result = await shouldDispatchForStatus('PVTI_1', '61e4505c');

		expect(result).toBe(true);
		// Atomic `SET key val EX ttl GET`: one round trip sets the new value and
		// returns the prior one, so a plain GET-then-SET race window can't open.
		expect(set).toHaveBeenCalledWith(`${NS}PVTI_1`, '61e4505c', 'EX', 5 * 60, 'GET');
	});

	it('skips (returns false) when the re-read status matches the last dispatched one', async () => {
		set.mockResolvedValue('61e4505c'); // SET...GET returns the prior value
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		const result = await shouldDispatchForStatus('PVTI_1', '61e4505c');

		expect(result).toBe(false);
	});

	it('dispatches again on a genuine status change, overwriting the stored value', async () => {
		set.mockResolvedValue('61e4505c'); // last dispatched: Planning
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		const result = await shouldDispatchForStatus('PVTI_1', '47fc9ee4'); // now: In progress

		expect(result).toBe(true);
		expect(set).toHaveBeenCalledWith(`${NS}PVTI_1`, '47fc9ee4', 'EX', 5 * 60, 'GET');
	});

	it('dispatches again on a return to a status the item already passed through', async () => {
		// Simulates: Planning -> In progress -> back to Planning. The stored value
		// reflects only the *last* dispatch (In progress), so the return to
		// Planning is a genuine change, not a repeat.
		set.mockResolvedValue('47fc9ee4');
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		const result = await shouldDispatchForStatus('PVTI_1', '61e4505c');

		expect(result).toBe(true);
	});

	it('fails closed (returns false) when the Redis call throws', async () => {
		set.mockRejectedValue(new Error('ECONNREFUSED'));
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		const result = await shouldDispatchForStatus('PVTI_1', '61e4505c');

		expect(result).toBe(false);
	});

	it('fails closed when REDIS_URL is unset (client construction throws)', async () => {
		process.env.REDIS_URL = '';
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		const result = await shouldDispatchForStatus('PVTI_1', '61e4505c');

		expect(result).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it('namespaces the key per item node ID, independent of status', async () => {
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		await shouldDispatchForStatus('PVTI_a', '61e4505c');
		await shouldDispatchForStatus('PVTI_b', '61e4505c');

		expect(set).toHaveBeenCalledWith(`${NS}PVTI_a`, '61e4505c', 'EX', 5 * 60, 'GET');
		expect(set).toHaveBeenCalledWith(`${NS}PVTI_b`, '61e4505c', 'EX', 5 * 60, 'GET');
	});

	it('reuses the one Redis singleton across calls', async () => {
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		await shouldDispatchForStatus('PVTI_1', '61e4505c');
		await shouldDispatchForStatus('PVTI_2', '47fc9ee4');

		expect(RedisMock).toHaveBeenCalledOnce();
	});

	it('constructs the client fail-fast: caps retries and registers an error listener', async () => {
		const { shouldDispatchForStatus } = await import('@/triggers/pm-status-dedup.js');

		await shouldDispatchForStatus('PVTI_1', '61e4505c');

		expect(RedisMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetriesPerRequest: 1 }));
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});
});
