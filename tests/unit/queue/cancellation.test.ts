import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches Redis — capture the set/publish/subscribe calls
// the cancellation module makes. Mirrors the project-concurrency test's shape.
const sadd = vi.fn<(key: string, member: string) => Promise<number>>();
const srem = vi.fn<(key: string, member: string) => Promise<number>>();
const sismember = vi.fn<(key: string, member: string) => Promise<number>>();
const hset = vi.fn<(key: string, field: string, value: string) => Promise<number>>();
const hget = vi.fn<(key: string, field: string) => Promise<string | null>>();
const hdel = vi.fn<(key: string, field: string) => Promise<number>>();
const publish = vi.fn<(channel: string, message: string) => Promise<number>>();
const subscribe = vi.fn<(channel: string) => Promise<number>>();
const quit = vi.fn<() => Promise<'OK'>>();
const disconnect = vi.fn<() => void>();
const on = vi.fn();

// A subscriber connection is created via `.duplicate()`; give it its own handlers
// so the message callback can be driven independently of the main client.
const subOn = vi.fn();
const subscriberClient = { on: subOn, subscribe, quit, disconnect };
const redisClient = {
	sadd,
	srem,
	sismember,
	hset,
	hget,
	hdel,
	publish,
	on,
	quit,
	disconnect,
	duplicate: () => subscriberClient,
};
const RedisMock = vi.fn<(options: Record<string, unknown>) => typeof redisClient>(
	() => redisClient,
);

vi.mock('ioredis', () => ({ Redis: RedisMock }));

const ORIGIN = { source: 'dashboard' as const, requestedAt: '2026-07-19T00:00:00.000Z' };

describe('run cancellation', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.REDIS_URL = 'redis://localhost:6379';
		sadd.mockResolvedValue(1);
		srem.mockResolvedValue(1);
		sismember.mockResolvedValue(0);
		hset.mockResolvedValue(1);
		hget.mockResolvedValue(null);
		hdel.mockResolvedValue(1);
		publish.mockResolvedValue(1);
		subscribe.mockResolvedValue(1);
		quit.mockResolvedValue('OK');
	});

	describe('requestRunCancellation', () => {
		it('records the run id in the durable set, its origin, and publishes a notification', async () => {
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await requestRunCancellation('run-1', ORIGIN);

			expect(sadd).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
			expect(hset).toHaveBeenCalledWith(
				'swarm:run-cancellation-origins',
				'run-1',
				JSON.stringify(ORIGIN),
			);
			expect(publish).toHaveBeenCalledWith('swarm:run-cancel', 'run-1');
		});

		it('still resolves when the notification publish fails (set write already landed)', async () => {
			publish.mockRejectedValueOnce(new Error('down'));
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await expect(requestRunCancellation('run-1', ORIGIN)).resolves.toBeUndefined();
			expect(sadd).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
		});

		it('still resolves when recording the origin fails (durable set entry already landed)', async () => {
			hset.mockRejectedValueOnce(new Error('down'));
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await expect(requestRunCancellation('run-1', ORIGIN)).resolves.toBeUndefined();
			expect(sadd).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
			expect(publish).toHaveBeenCalledWith('swarm:run-cancel', 'run-1');
		});
	});

	describe('isRunCancellationRequested', () => {
		it('returns true when the run id is a member of the set', async () => {
			sismember.mockResolvedValue(1);
			const { isRunCancellationRequested } = await import('@/queue/cancellation.js');

			expect(await isRunCancellationRequested('run-1')).toBe(true);
			expect(sismember).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
		});

		it('returns false when the run id is not present', async () => {
			sismember.mockResolvedValue(0);
			const { isRunCancellationRequested } = await import('@/queue/cancellation.js');

			expect(await isRunCancellationRequested('run-1')).toBe(false);
		});

		it('fails safe to false on a Redis read error (never spuriously terminates)', async () => {
			sismember.mockRejectedValue(new Error('down'));
			const { isRunCancellationRequested } = await import('@/queue/cancellation.js');

			expect(await isRunCancellationRequested('run-1')).toBe(false);
		});
	});

	describe('clearRunCancellation', () => {
		it('removes the run id from the set and its recorded origin', async () => {
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await clearRunCancellation('run-1');
			expect(srem).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
			expect(hdel).toHaveBeenCalledWith('swarm:run-cancellation-origins', 'run-1');
		});

		it('swallows a clear failure', async () => {
			srem.mockRejectedValueOnce(new Error('down'));
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await expect(clearRunCancellation('run-1')).resolves.toBeUndefined();
		});
	});

	describe('getRunCancellationOrigin', () => {
		it('returns the recorded origin when one was stored', async () => {
			hget.mockResolvedValue(JSON.stringify(ORIGIN));
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toEqual(ORIGIN);
			expect(hget).toHaveBeenCalledWith('swarm:run-cancellation-origins', 'run-1');
		});

		it('returns null for a marker-only cancellation (no origin ever recorded)', async () => {
			hget.mockResolvedValue(null);
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});

		it('returns null and never throws on malformed JSON', async () => {
			hget.mockResolvedValue('{not json');
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});

		it('returns null for a record that fails schema validation', async () => {
			hget.mockResolvedValue(JSON.stringify({ source: 'not-a-real-source' }));
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});

		it('fails safe to null on a Redis read error', async () => {
			hget.mockRejectedValue(new Error('down'));
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});
	});

	describe('subscribeToRunCancellations', () => {
		it('subscribes on a duplicated connection and invokes the callback for a matching message', async () => {
			const { subscribeToRunCancellations } = await import('@/queue/cancellation.js');
			const onCancel = vi.fn();

			subscribeToRunCancellations(onCancel);

			expect(subscribe).toHaveBeenCalledWith('swarm:run-cancel');
			// Drive the registered 'message' handler as ioredis would.
			const handler = subOn.mock.calls.find((c) => c[0] === 'message')?.[1] as (
				channel: string,
				message: string,
			) => void;
			handler('swarm:run-cancel', 'run-42');
			expect(onCancel).toHaveBeenCalledWith('run-42');
		});

		it('ignores messages from other channels', async () => {
			const { subscribeToRunCancellations } = await import('@/queue/cancellation.js');
			const onCancel = vi.fn();

			subscribeToRunCancellations(onCancel);
			const handler = subOn.mock.calls.find((c) => c[0] === 'message')?.[1] as (
				channel: string,
				message: string,
			) => void;
			handler('some-other-channel', 'run-42');
			expect(onCancel).not.toHaveBeenCalled();
		});

		it('closes the subscriber connection', async () => {
			const { subscribeToRunCancellations } = await import('@/queue/cancellation.js');

			const subscription = subscribeToRunCancellations(vi.fn());
			await subscription.close();
			expect(quit).toHaveBeenCalled();
		});
	});

	describe('RUN_CANCELLED_MESSAGE', () => {
		it('is neutral — it never asserts who or where a cancellation came from', async () => {
			const { RUN_CANCELLED_MESSAGE } = await import('@/queue/cancellation.js');

			expect(RUN_CANCELLED_MESSAGE).toBe('Run cancelled after a cancellation request.');
			expect(RUN_CANCELLED_MESSAGE.toLowerCase()).not.toContain('user');
			expect(RUN_CANCELLED_MESSAGE.toLowerCase()).not.toContain('dashboard');
		});
	});
});
