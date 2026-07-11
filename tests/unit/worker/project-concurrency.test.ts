import { beforeEach, describe, expect, it, vi } from 'vitest';

const incr = vi.fn<(key: string) => Promise<number>>();
const decr = vi.fn<(key: string) => Promise<number>>();
const del = vi.fn<(key: string) => Promise<number>>();
const set = vi.fn<(key: string, value: string) => Promise<'OK'>>();
const on = vi.fn();
const redisClient = { incr, decr, del, set, on };
const RedisMock = vi.fn<(options: Record<string, unknown>) => typeof redisClient>(
	() => redisClient,
);

vi.mock('ioredis', () => ({ Redis: RedisMock }));

describe('project concurrency', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.REDIS_URL = 'redis://localhost:6379';
		incr.mockResolvedValue(1);
		decr.mockResolvedValue(0);
		del.mockResolvedValue(1);
		set.mockResolvedValue('OK');
	});

	it('acquires atomically below and at the limit using one fail-fast client', async () => {
		const { acquireProjectSlot } = await import('@/worker/project-concurrency.js');

		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: true, tracked: true });
		incr.mockResolvedValueOnce(2);
		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: true, tracked: true });
		expect(RedisMock).toHaveBeenCalledOnce();
		expect(RedisMock.mock.calls[0][0]).toMatchObject({ maxRetriesPerRequest: 1 });
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});

	it('returns an over-limit increment before deferring', async () => {
		incr.mockResolvedValue(3);
		const { acquireProjectSlot } = await import('@/worker/project-concurrency.js');

		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: false });
		expect(decr).toHaveBeenCalledWith('swarm:project-slots:alpha');
	});

	it('fails open when Redis cannot acquire', async () => {
		incr.mockRejectedValue(new Error('down'));
		const { acquireProjectSlot } = await import('@/worker/project-concurrency.js');

		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: true, tracked: false });
	});

	it('releases slots and floors a stray negative count', async () => {
		decr.mockResolvedValue(-1);
		const { releaseProjectSlot } = await import('@/worker/project-concurrency.js');

		await releaseProjectSlot('alpha');
		expect(set).toHaveBeenCalledWith('swarm:project-slots:alpha', '0');
	});

	it('resets a project counter and swallows reset failures', async () => {
		const { resetProjectSlot } = await import('@/worker/project-concurrency.js');

		await resetProjectSlot('alpha');
		expect(del).toHaveBeenCalledWith('swarm:project-slots:alpha');
		del.mockRejectedValueOnce(new Error('down'));
		await expect(resetProjectSlot('alpha')).resolves.toBeUndefined();
	});
});
