import type { QueueOptions } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
} from '../../helpers/factories.js';

// Mock BullMQ's Queue so nothing touches Redis — capture constructor args and
// the add()/close() calls the producer makes. Hoisted so the vi.mock factory
// (itself hoisted above imports) can reference them.
const { QueueMock, add, close, getDelayed, getWaiting } = vi.hoisted(() => {
	// Typed with add()'s (name, data, opts) signature so `mock.calls[0]` is a
	// real tuple that destructures/indexes under typecheck (see ai/TESTING.md).
	const add =
		vi.fn<
			(name: string, data: unknown, opts?: { jobId?: string; delay?: number }) => Promise<unknown>
		>();
	const close = vi.fn();
	const getDelayed = vi.fn<() => Promise<Array<{ name: string; remove: () => Promise<void> }>>>();
	const getWaiting = vi.fn<() => Promise<Array<{ name: string; remove: () => Promise<void> }>>>();
	// Typed with the Queue constructor's (name, opts) signature so `mock.calls`
	// is a real tuple — untyped, vi.fn() infers a zero-arg call and indexing
	// `calls[0]` fails to typecheck.
	const QueueMock = vi.fn<
		(
			name: string,
			opts?: QueueOptions,
		) => {
			add: typeof add;
			close: typeof close;
			getDelayed: typeof getDelayed;
			getWaiting: typeof getWaiting;
		}
	>(() => ({ add, close, getDelayed, getWaiting }));
	return { QueueMock, add, close, getDelayed, getWaiting };
});

vi.mock('bullmq', () => ({ Queue: QueueMock }));

// The producer holds a lazy Queue singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions aren't cross-polluted.
beforeEach(() => {
	vi.resetModules();
	QueueMock.mockClear();
	add.mockReset();
	add.mockResolvedValue({ id: 'bull-assigned-id' });
	close.mockReset();
	close.mockResolvedValue(undefined);
	getDelayed.mockReset();
	getDelayed.mockResolvedValue([]);
	getWaiting.mockReset();
	getWaiting.mockResolvedValue([]);
	process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('enqueueJob', () => {
	it('creates the queue on QUEUE_NAME with the parsed Redis connection', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());

		expect(QueueMock).toHaveBeenCalledOnce();
		const [name, opts] = QueueMock.mock.calls[0];
		expect(name).toBe('swarm-jobs');
		expect(opts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
	});

	it('configures the load-bearing default job options', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());

		const [, opts] = QueueMock.mock.calls[0];
		// The retry-safety + Redis-hygiene story hinges on these exact values —
		// lock them against accidental regression (see producer.ts rationale).
		expect(opts).toMatchObject({
			defaultJobOptions: {
				attempts: 3,
				backoff: { type: 'exponential', delay: 5_000 },
				removeOnComplete: { age: 24 * 60 * 60, count: 100 },
				removeOnFail: { age: 7 * 24 * 60 * 60 },
			},
		});
	});

	it('adds a github job named by its type, using deliveryId as the job id', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob();

		const id = await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('github', job, { jobId: job.deliveryId });
		expect(id).toBe('bull-assigned-id');
	});

	it('adds a github-projects job named by its type', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockGitHubProjectsWebhookJob();

		await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('github-projects', job, { jobId: job.deliveryId });
	});

	it('omits the job id when the event carries no deliveryId', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const { deliveryId: _dropped, ...job } = createMockGitHubWebhookJob();

		await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('github', job, undefined);
	});

	it('reuses the one queue singleton across enqueues', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());
		await enqueueJob(createMockGitHubProjectsWebhookJob());

		expect(QueueMock).toHaveBeenCalledOnce();
		expect(add).toHaveBeenCalledTimes(2);
	});

	it('throws if REDIS_URL is unset (config error surfaces at first enqueue)', async () => {
		process.env.REDIS_URL = '';
		const { enqueueJob } = await import('@/queue/producer.js');

		await expect(enqueueJob(createMockGitHubWebhookJob())).rejects.toThrow(/REDIS_URL/);
		expect(QueueMock).not.toHaveBeenCalled();
	});
});

describe('scheduleCoalescedJob', () => {
	it('adds a delayed job named by the coalesce key, with a unique colon-free id', async () => {
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob();

		await scheduleCoalescedJob(job, 'check-suite:jkwiecien/swarm:9:cafe', 30_000);

		expect(add).toHaveBeenCalledOnce();
		const [name, addedJob, opts] = add.mock.calls[0];
		expect(name).toBe('check-suite:jkwiecien/swarm:9:cafe');
		expect(addedJob).toBe(job);
		expect(opts).toMatchObject({ delay: 30_000 });
		expect(opts?.jobId).toMatch(/^coalesce_/);
		expect(opts?.jobId).not.toContain(':');
	});

	it('supersedes pending jobs sharing the coalesce key before scheduling', async () => {
		const remove = vi.fn().mockResolvedValue(undefined);
		const staleRemove = vi.fn().mockResolvedValue(undefined);
		getDelayed.mockResolvedValue([
			{ name: 'check-suite:jkwiecien/swarm:9:cafe', remove },
			{ name: 'some-other-key', remove: staleRemove },
		]);
		getWaiting.mockResolvedValue([]);
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');

		await scheduleCoalescedJob(
			createMockGitHubWebhookJob(),
			'check-suite:jkwiecien/swarm:9:cafe',
			30_000,
		);

		expect(remove).toHaveBeenCalledOnce();
		expect(staleRemove).not.toHaveBeenCalled();
		expect(add).toHaveBeenCalledOnce();
	});

	it('supersedes a matching job found in the waiting set (delay elapsed, not yet picked up)', async () => {
		// A prior recheck whose delay already elapsed sits in `waiting`, not
		// `delayed` — the supersede must match it there too, else two rechecks
		// for one key survive.
		const remove = vi.fn().mockResolvedValue(undefined);
		const staleRemove = vi.fn().mockResolvedValue(undefined);
		getDelayed.mockResolvedValue([]);
		getWaiting.mockResolvedValue([
			{ name: 'check-suite:jkwiecien/swarm:9:cafe', remove },
			{ name: 'some-other-key', remove: staleRemove },
		]);
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');

		await scheduleCoalescedJob(
			createMockGitHubWebhookJob(),
			'check-suite:jkwiecien/swarm:9:cafe',
			30_000,
		);

		expect(remove).toHaveBeenCalledOnce();
		expect(staleRemove).not.toHaveBeenCalled();
		expect(add).toHaveBeenCalledOnce();
	});

	it('schedules without removing anything when no pending job matches', async () => {
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');

		await scheduleCoalescedJob(
			createMockGitHubWebhookJob(),
			'check-suite:jkwiecien/swarm:9:cafe',
			30_000,
		);

		expect(add).toHaveBeenCalledOnce();
	});
});

describe('enqueueDelayedRetry', () => {
	it('adds a delayed job with a fresh colon-free id, not the deliveryId', async () => {
		const { enqueueDelayedRetry } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob({ rateLimitRetryAttempt: 1 });

		const id = await enqueueDelayedRetry(job, 6 * 60 * 1000);

		expect(add).toHaveBeenCalledOnce();
		const [name, addedJob, opts] = add.mock.calls[0];
		expect(name).toBe('github');
		expect(addedJob).toBe(job);
		expect(opts).toMatchObject({ delay: 6 * 60 * 1000 });
		// A fresh id: the original delivery-id-keyed job is still in Redis, so
		// reusing its id would make BullMQ drop the retry.
		expect(opts?.jobId).toMatch(/^retry_github_/);
		expect(opts?.jobId).not.toBe(job.deliveryId);
		expect(opts?.jobId).not.toContain(':');
		expect(id).toBe('bull-assigned-id');
	});
});

describe('closeQueue', () => {
	it('closes the queue once it has been created', async () => {
		const { enqueueJob, closeQueue } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());

		await closeQueue();

		expect(close).toHaveBeenCalledOnce();
	});

	it('is a no-op when nothing was ever enqueued', async () => {
		const { closeQueue } = await import('@/queue/producer.js');

		await expect(closeQueue()).resolves.toBeUndefined();
		expect(close).not.toHaveBeenCalled();
	});

	it('recreates the queue on the next enqueue after a close', async () => {
		const { enqueueJob, closeQueue } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());
		await closeQueue();
		await enqueueJob(createMockGitHubWebhookJob());

		expect(QueueMock).toHaveBeenCalledTimes(2);
	});
});
