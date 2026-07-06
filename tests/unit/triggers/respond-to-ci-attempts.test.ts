import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches a real Redis — capture the constructor and the
// incr()/expire() calls the helper makes. Hoisted so the vi.mock factory (itself
// hoisted above imports) can reference them.
const { RedisMock, incr, expire, on } = vi.hoisted(() => {
	const incr = vi.fn();
	const expire = vi.fn();
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ incr, expire, on }));
	return { RedisMock, incr, expire, on };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

// The helper holds a lazy Redis singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions don't cross-pollute.
beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	incr.mockReset();
	incr.mockResolvedValue(1);
	expire.mockReset();
	expire.mockResolvedValue(1);
	on.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

const NS = 'swarm:respond-to-ci-attempts:';
const CTX = { prNumber: '42', headSha: 'abc' };

describe('buildRespondToCiAttemptKey', () => {
	it('joins owner/repo and PR number', async () => {
		const { buildRespondToCiAttemptKey } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(buildRespondToCiAttemptKey('acme/widgets', '42')).toBe('acme/widgets:42');
	});
});

describe('claimRespondToCiAttempt', () => {
	it('increments the namespaced key, refreshes its TTL, and allows an attempt under the cap', async () => {
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');

		const claim = await claimRespondToCiAttempt('acme/widgets:42', CTX);

		expect(claim).toEqual({ allowed: true, attempt: 1 });
		expect(incr).toHaveBeenCalledWith(`${NS}acme/widgets:42`);
		expect(expire).toHaveBeenCalledWith(`${NS}acme/widgets:42`, 3600);
	});

	it('allows the attempt exactly at the cap', async () => {
		incr.mockResolvedValue(3);
		const { claimRespondToCiAttempt, MAX_FIX_ATTEMPTS } = await import(
			'@/triggers/respond-to-ci-attempts.js'
		);
		expect(MAX_FIX_ATTEMPTS).toBe(3);
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 3,
		});
	});

	it('denies the attempt once the counter exceeds the cap', async () => {
		incr.mockResolvedValue(4);
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: false,
			attempt: 4,
		});
	});

	it('fails OPEN (allows) when the Redis call throws — a blip must not disable CI-fix', async () => {
		incr.mockRejectedValue(new Error('ECONNREFUSED'));
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 0,
		});
	});

	it('fails open when REDIS_URL is unset (client construction throws)', async () => {
		process.env.REDIS_URL = '';
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 0,
		});
		expect(incr).not.toHaveBeenCalled();
	});

	it('reuses the one Redis singleton across claims', async () => {
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		await claimRespondToCiAttempt('acme/widgets:1', { prNumber: '1', headSha: 'a' });
		await claimRespondToCiAttempt('acme/widgets:2', { prNumber: '2', headSha: 'b' });
		expect(RedisMock).toHaveBeenCalledOnce();
		expect(incr).toHaveBeenCalledTimes(2);
	});

	it('constructs the client fail-fast: caps retries and registers an error listener', async () => {
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		await claimRespondToCiAttempt('acme/widgets:1', { prNumber: '1', headSha: 'a' });
		expect(RedisMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetriesPerRequest: 1 }));
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});
});
