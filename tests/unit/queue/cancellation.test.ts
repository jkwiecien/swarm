import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches Redis — capture the set/publish/subscribe calls
// the cancellation module makes. Mirrors the project-concurrency test's shape.
const sadd = vi.fn<(key: string, member: string) => Promise<number>>();
const srem = vi.fn<(key: string, member: string) => Promise<number>>();
const sismember = vi.fn<(key: string, member: string) => Promise<number>>();
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

describe('run cancellation', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.REDIS_URL = 'redis://localhost:6379';
		sadd.mockResolvedValue(1);
		srem.mockResolvedValue(1);
		sismember.mockResolvedValue(0);
		publish.mockResolvedValue(1);
		subscribe.mockResolvedValue(1);
		quit.mockResolvedValue('OK');
	});

	describe('requestRunCancellation', () => {
		it('records the run id in the durable set and publishes a notification', async () => {
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await requestRunCancellation('run-1');

			expect(sadd).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
			expect(publish).toHaveBeenCalledWith('swarm:run-cancel', 'run-1');
		});

		it('still resolves when the notification publish fails (set write already landed)', async () => {
			publish.mockRejectedValueOnce(new Error('down'));
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await expect(requestRunCancellation('run-1')).resolves.toBeUndefined();
			expect(sadd).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
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
		it('removes the run id from the set', async () => {
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await clearRunCancellation('run-1');
			expect(srem).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
		});

		it('swallows a clear failure', async () => {
			srem.mockRejectedValueOnce(new Error('down'));
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await expect(clearRunCancellation('run-1')).resolves.toBeUndefined();
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
});
