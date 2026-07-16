import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror project-concurrency.test.ts: mock ioredis at the module boundary and
// drive the HASH ops the registry uses. A single fail-fast client with an
// 'error' listener is asserted, same posture as the slot counter.
const hset = vi.fn<(key: string, field: string, value: string) => Promise<number>>();
const hgetall = vi.fn<(key: string) => Promise<Record<string, string>>>();
const hdel = vi.fn<(key: string, field: string) => Promise<number>>();
const hlen = vi.fn<(key: string) => Promise<number>>();
const del = vi.fn<(key: string) => Promise<number>>();
const on = vi.fn();
const redisClient = { hset, hgetall, hdel, hlen, del, on };
const RedisMock = vi.fn<(options: Record<string, unknown>) => typeof redisClient>(
	() => redisClient,
);

vi.mock('ioredis', () => ({ Redis: RedisMock }));

describe('pending continuations registry', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.REDIS_URL = 'redis://localhost:6379';
		hset.mockResolvedValue(1);
		hgetall.mockResolvedValue({});
		hdel.mockResolvedValue(1);
		hlen.mockResolvedValue(0);
		del.mockResolvedValue(1);
	});

	it('registers keyed on <taskId>:<phase> via one fail-fast client', async () => {
		const { registerPendingContinuation } = await import('@/worker/pending-continuations.js');

		await registerPendingContinuation('alpha', {
			jobId: 'retry-1',
			taskId: '17',
			phase: 'review',
			enqueuedAt: 100,
		});

		expect(hset).toHaveBeenCalledWith(
			'swarm:pending-continuations:alpha',
			'17:review',
			JSON.stringify({ jobId: 'retry-1', taskId: '17', phase: 'review', enqueuedAt: 100 }),
		);
		expect(RedisMock).toHaveBeenCalledOnce();
		expect(RedisMock.mock.calls[0][0]).toMatchObject({ maxRetriesPerRequest: 1 });
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});

	it('re-deferring the same task+phase replaces rather than stacks (same field)', async () => {
		const { registerPendingContinuation } = await import('@/worker/pending-continuations.js');

		await registerPendingContinuation('alpha', {
			jobId: 'retry-1',
			taskId: '17',
			phase: 'review',
			enqueuedAt: 100,
		});
		await registerPendingContinuation('alpha', {
			jobId: 'retry-2',
			taskId: '17',
			phase: 'review',
			enqueuedAt: 200,
		});

		// Both HSETs target the same field, so the second overwrites the first.
		expect(hset.mock.calls[0][1]).toBe('17:review');
		expect(hset.mock.calls[1][1]).toBe('17:review');
	});

	it('takes the oldest pending continuation by enqueuedAt (FIFO) and deletes it', async () => {
		hgetall.mockResolvedValue({
			'20:review': JSON.stringify({
				jobId: 'retry-late',
				taskId: '20',
				phase: 'review',
				enqueuedAt: 300,
			}),
			'17:review': JSON.stringify({
				jobId: 'retry-early',
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
			}),
		});
		const { takeNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		const next = await takeNextPendingContinuation('alpha');

		expect(next).toEqual({ jobId: 'retry-early', taskId: '17', phase: 'review', enqueuedAt: 100 });
		// Only the returned (oldest) field is removed.
		expect(hdel).toHaveBeenCalledExactlyOnceWith('swarm:pending-continuations:alpha', '17:review');
	});

	it('returns null when nothing is pending', async () => {
		hgetall.mockResolvedValue({});
		const { takeNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		expect(await takeNextPendingContinuation('alpha')).toBeNull();
		expect(hdel).not.toHaveBeenCalled();
	});

	it('drops a corrupt entry in passing and returns the next valid one', async () => {
		hgetall.mockResolvedValue({
			'bad:review': 'not-json',
			'17:review': JSON.stringify({
				jobId: 'retry-1',
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
			}),
		});
		const { takeNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		const next = await takeNextPendingContinuation('alpha');

		expect(next).toMatchObject({ jobId: 'retry-1' });
		// The malformed field is deleted, as is the returned one.
		expect(hdel).toHaveBeenCalledWith('swarm:pending-continuations:alpha', 'bad:review');
		expect(hdel).toHaveBeenCalledWith('swarm:pending-continuations:alpha', '17:review');
	});

	it('counts and clears a project registry', async () => {
		hlen.mockResolvedValue(3);
		const { countPendingContinuations, clearPendingContinuations } = await import(
			'@/worker/pending-continuations.js'
		);

		expect(await countPendingContinuations('alpha')).toBe(3);
		expect(hlen).toHaveBeenCalledWith('swarm:pending-continuations:alpha');

		await clearPendingContinuations('alpha');
		expect(del).toHaveBeenCalledWith('swarm:pending-continuations:alpha');
	});

	it('fails open on Redis errors — register no-ops, take returns null', async () => {
		hset.mockRejectedValue(new Error('down'));
		hgetall.mockRejectedValue(new Error('down'));
		const { registerPendingContinuation, takeNextPendingContinuation } = await import(
			'@/worker/pending-continuations.js'
		);

		await expect(
			registerPendingContinuation('alpha', {
				jobId: 'retry-1',
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
			}),
		).resolves.toBeUndefined();
		expect(await takeNextPendingContinuation('alpha')).toBeNull();
	});
});
