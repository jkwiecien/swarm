import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches a real Redis — capture the constructor and the
// set()/del() calls the helper makes. Hoisted so the vi.mock factory (itself
// hoisted above imports) can reference them.
const { RedisMock, set, del, keys, quit, on } = vi.hoisted(() => {
	const set = vi.fn();
	const del = vi.fn();
	const keys = vi.fn();
	const quit = vi.fn();
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ set, del, keys, quit, on }));
	return { RedisMock, set, del, keys, quit, on };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

// The helper holds a lazy Redis singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions don't cross-pollute.
beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	set.mockReset();
	set.mockResolvedValue('OK');
	del.mockReset();
	del.mockResolvedValue(1);
	keys.mockReset();
	keys.mockResolvedValue([]);
	quit.mockReset();
	quit.mockResolvedValue('OK');
	on.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

const NS = 'swarm:review-dedup:';

describe('buildReviewDispatchKey', () => {
	it('joins owner/repo, PR number, and head SHA', async () => {
		const { buildReviewDispatchKey } = await import('@/triggers/review-dispatch-dedup.js');
		expect(buildReviewDispatchKey('acme/widgets', '42', 'abc123')).toBe('acme/widgets:42:abc123');
	});
});

describe('claimReviewDispatch', () => {
	it('claims with SET NX EX on the namespaced key and returns true', async () => {
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(true);
		expect(set).toHaveBeenCalledWith(`${NS}acme/widgets:42:abc`, 'pr-review', 'EX', 300, 'NX');
	});

	it('returns false when the key is already claimed (SET NX returns null)', async () => {
		set.mockResolvedValue(null);
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(false);
	});

	it('fails closed (returns false) when the Redis call throws', async () => {
		set.mockRejectedValue(new Error('ECONNREFUSED'));
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(false);
	});

	it('fails closed when REDIS_URL is unset (client construction throws)', async () => {
		process.env.REDIS_URL = '';
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it('reuses the one Redis singleton across claims', async () => {
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		await claimReviewDispatch('acme/widgets:1:a', 'pr-review', { prNumber: '1', headSha: 'a' });
		await claimReviewDispatch('acme/widgets:2:b', 'pr-review', { prNumber: '2', headSha: 'b' });

		expect(RedisMock).toHaveBeenCalledOnce();
		expect(set).toHaveBeenCalledTimes(2);
	});
});

describe('releaseReviewDispatch', () => {
	it('deletes the namespaced key', async () => {
		const { releaseReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		await releaseReviewDispatch('acme/widgets:42:abc');

		expect(del).toHaveBeenCalledWith(`${NS}acme/widgets:42:abc`);
	});

	it('swallows Redis errors (TTL is the safety net)', async () => {
		del.mockRejectedValue(new Error('ECONNREFUSED'));
		const { releaseReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(releaseReviewDispatch('acme/widgets:42:abc')).resolves.toBeUndefined();
	});
});
