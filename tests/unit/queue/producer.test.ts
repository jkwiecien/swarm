import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
} from '../../helpers/factories.js';

// Mock BullMQ's Queue so nothing touches Redis — capture constructor args and
// the add()/close() calls the producer makes. Hoisted so the vi.mock factory
// (itself hoisted above imports) can reference them.
const { QueueMock, add, close } = vi.hoisted(() => {
	const add = vi.fn();
	const close = vi.fn();
	const QueueMock = vi.fn(() => ({ add, close }));
	return { QueueMock, add, close };
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
