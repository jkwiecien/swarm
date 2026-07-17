import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockGitHubWebhookJob } from '../../helpers/factories.js';

// Mirror project-concurrency.test.ts: mock ioredis at the module boundary and
// drive the HASH ops the registry uses. A single fail-fast client with an
// 'error' listener is asserted, same posture as the slot counter.
const hset = vi.fn<(key: string, field: string, value: string) => Promise<number>>();
const hgetall = vi.fn<(key: string) => Promise<Record<string, string>>>();
const hdel = vi.fn<(key: string, field: string) => Promise<number>>();
const hlen = vi.fn<(key: string) => Promise<number>>();
const del = vi.fn<(key: string) => Promise<number>>();
const keys = vi.fn<(pattern: string) => Promise<string[]>>();
const set =
	vi.fn<
		(key: string, value: string, mode: 'PX', ttl: number, condition: 'NX') => Promise<'OK' | null>
	>();
const evalScript = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const on = vi.fn();
const redisClient = { hset, hgetall, hdel, hlen, del, keys, set, eval: evalScript, on };
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
		keys.mockResolvedValue([]);
		set.mockResolvedValue('OK');
		evalScript.mockResolvedValue(1);
	});

	it('registers keyed on <taskId>:<phase> via one fail-fast client', async () => {
		const { registerPendingContinuation } = await import('@/worker/pending-continuations.js');

		await registerPendingContinuation('alpha', {
			taskId: '17',
			phase: 'review',
			enqueuedAt: 100,
			job: createMockGitHubWebhookJob(),
			continuation: false,
		});

		expect(hset).toHaveBeenCalledWith(
			'swarm:pending-continuations:alpha',
			'17:review',
			JSON.stringify({
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob(),
				continuation: false,
			}),
		);
		expect(RedisMock).toHaveBeenCalledOnce();
		expect(RedisMock.mock.calls[0][0]).toMatchObject({ maxRetriesPerRequest: 1 });
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});

	it('re-deferring the same task+phase replaces rather than stacks (same field)', async () => {
		const { registerPendingContinuation } = await import('@/worker/pending-continuations.js');

		await registerPendingContinuation('alpha', {
			taskId: '17',
			phase: 'review',
			enqueuedAt: 100,
			job: createMockGitHubWebhookJob(),
			continuation: false,
		});
		await registerPendingContinuation('alpha', {
			taskId: '17',
			phase: 'review',
			enqueuedAt: 200,
			job: createMockGitHubWebhookJob(),
			continuation: false,
		});

		// Both HSETs target the same field, so the second overwrites the first.
		expect(hset.mock.calls[0][1]).toBe('17:review');
		expect(hset.mock.calls[1][1]).toBe('17:review');
	});

	it('takes the oldest pending continuation by enqueuedAt (FIFO)', async () => {
		hgetall.mockResolvedValue({
			'20:review': JSON.stringify({
				taskId: '20',
				phase: 'review',
				enqueuedAt: 300,
				job: createMockGitHubWebhookJob(),
				continuation: false,
			}),
			'17:review': JSON.stringify({
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob(),
				continuation: false,
			}),
		});
		const { takeNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		const next = await takeNextPendingContinuation('alpha', false);

		expect(next).toMatchObject({ taskId: '17', phase: 'review', enqueuedAt: 100 });
		expect(hdel).not.toHaveBeenCalled();
	});

	it('promotes an SCM continuation ahead of older board work only when configured', async () => {
		hgetall.mockResolvedValue({
			'10:planning': JSON.stringify({
				taskId: '10',
				phase: 'planning',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob(),
				continuation: false,
			}),
			'17:review': JSON.stringify({
				taskId: '17',
				phase: 'review',
				enqueuedAt: 200,
				job: createMockGitHubWebhookJob(),
				continuation: true,
			}),
		});
		const { takeNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		expect(await takeNextPendingContinuation('alpha', true)).toMatchObject({ taskId: '17' });
		hdel.mockClear();
		expect(await takeNextPendingContinuation('alpha', false)).toMatchObject({ taskId: '10' });
	});

	it('gives concurrent slot releases one lease owner', async () => {
		hgetall.mockResolvedValue({
			'17:review': JSON.stringify({
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob(),
				continuation: true,
			}),
		});
		set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
		const { claimNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		const [first, second] = await Promise.all([
			claimNextPendingContinuation('alpha', true),
			claimNextPendingContinuation('alpha', true),
		]);

		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(set).toHaveBeenCalledWith(
			'swarm:pending-continuation-claims:alpha:17:review',
			expect.any(String),
			'PX',
			30_000,
			'NX',
		);
	});

	it('acknowledges a claimed handoff with an ownership-checked delete', async () => {
		const { acknowledgePendingContinuationClaim } = await import(
			'@/worker/pending-continuations.js'
		);
		await acknowledgePendingContinuationClaim('alpha', {
			entry: {
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob(),
				continuation: true,
			},
			field: '17:review',
			raw: 'stored-json',
			token: 'lease-token',
		});

		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining("redis.call('HDEL'"),
			2,
			'swarm:pending-continuations:alpha',
			'swarm:pending-continuation-claims:alpha:17:review',
			'lease-token',
			'17:review',
			'stored-json',
		);
	});

	it('removes every pending entry belonging to a terminated run', async () => {
		keys.mockResolvedValue(['swarm:pending-continuations:alpha']);
		hgetall.mockResolvedValue({
			'10:planning': JSON.stringify({
				taskId: '10',
				phase: 'planning',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob({ runId: 'run-1' }),
				continuation: false,
			}),
			'17:review': JSON.stringify({
				taskId: '17',
				phase: 'review',
				enqueuedAt: 200,
				job: createMockGitHubWebhookJob({ runId: 'run-2' }),
				continuation: true,
			}),
		});
		const { removePendingContinuationForRun } = await import('@/worker/pending-continuations.js');

		expect(await removePendingContinuationForRun('run-1')).toBe(1);
		expect(hdel).toHaveBeenCalledWith('swarm:pending-continuations:alpha', '10:planning');
	});

	it('removes a dispatched entry only after BullMQ accepted it', async () => {
		const { removePendingContinuation } = await import('@/worker/pending-continuations.js');

		await removePendingContinuation('alpha', { taskId: '17', phase: 'review' });

		expect(hdel).toHaveBeenCalledWith('swarm:pending-continuations:alpha', '17:review');
	});

	it('returns null when nothing is pending', async () => {
		hgetall.mockResolvedValue({});
		const { takeNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		expect(await takeNextPendingContinuation('alpha', false)).toBeNull();
		expect(hdel).not.toHaveBeenCalled();
	});

	it('drops a corrupt entry in passing and returns the next valid one', async () => {
		hgetall.mockResolvedValue({
			'bad:review': 'not-json',
			'17:review': JSON.stringify({
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob(),
				continuation: false,
			}),
		});
		const { takeNextPendingContinuation } = await import('@/worker/pending-continuations.js');

		const next = await takeNextPendingContinuation('alpha', false);

		expect(next).toMatchObject({ taskId: '17', phase: 'review' });
		// Only the malformed field is deleted; dispatch removal happens after enqueue.
		expect(hdel).toHaveBeenCalledWith('swarm:pending-continuations:alpha', 'bad:review');
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
				taskId: '17',
				phase: 'review',
				enqueuedAt: 100,
				job: createMockGitHubWebhookJob(),
				continuation: false,
			}),
		).resolves.toBeUndefined();
		expect(await takeNextPendingContinuation('alpha', false)).toBeNull();
	});
});
