import type { QueueOptions } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock BullMQ's Queue so nothing touches Redis — mirrors
// `tests/unit/queue/producer.test.ts`'s mocking shape for the same reason.
const { QueueMock, add } = vi.hoisted(() => {
	const add =
		vi.fn<
			(name: string, data: unknown, opts?: { jobId?: string; delay?: number }) => Promise<unknown>
		>();
	const QueueMock = vi.fn<(name: string, opts?: QueueOptions) => { add: typeof add }>(() => ({
		add,
	}));
	return { QueueMock, add };
});

vi.mock('bullmq', () => ({ Queue: QueueMock }));

// The producer holds a lazy Queue singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions aren't cross-polluted.
beforeEach(() => {
	vi.resetModules();
	QueueMock.mockClear();
	add.mockReset();
	add.mockResolvedValue({ id: 'bull-assigned-id' });
	process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('enqueueMergeFollowUp', () => {
	it('creates the queue on its own dedicated queue name', async () => {
		const { enqueueMergeFollowUp, MERGE_FOLLOW_UP_QUEUE_NAME } = await import(
			'@/queue/merge-follow-up.js'
		);
		await enqueueMergeFollowUp(
			{ projectId: 'p1', runId: 'run-1', prNumber: '42', approvedHeadSha: 'sha-1', attempt: 1 },
			15_000,
		);

		expect(QueueMock).toHaveBeenCalledOnce();
		const [name, opts] = QueueMock.mock.calls[0];
		expect(name).toBe(MERGE_FOLLOW_UP_QUEUE_NAME);
		expect(name).toBe('swarm-merge-follow-ups');
		expect(opts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
	});

	it('configures BullMQ retries for infrastructure/system failures — functional retries are handled explicitly', async () => {
		const { enqueueMergeFollowUp } = await import('@/queue/merge-follow-up.js');
		await enqueueMergeFollowUp(
			{ projectId: 'p1', runId: 'run-1', prNumber: '42', approvedHeadSha: 'sha-1', attempt: 1 },
			15_000,
		);

		const [, opts] = QueueMock.mock.calls[0];
		expect(opts).toMatchObject({
			defaultJobOptions: {
				attempts: 3,
				backoff: { type: 'exponential', delay: 5_000 },
			},
		});
	});

	it('schedules the job after the given delay with a deterministic run+attempt job id', async () => {
		const { enqueueMergeFollowUp } = await import('@/queue/merge-follow-up.js');
		const job = {
			projectId: 'p1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			attempt: 2,
		};

		await enqueueMergeFollowUp(job, 30_000);

		expect(add).toHaveBeenCalledWith('merge-follow-up', job, {
			jobId: 'merge-followup_run-1_2',
			delay: 30_000,
		});
	});

	it('uses the same deterministic job id for the same run and attempt (dedup)', async () => {
		const { enqueueMergeFollowUp } = await import('@/queue/merge-follow-up.js');
		const job = {
			projectId: 'p1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			attempt: 4,
		};

		await enqueueMergeFollowUp(job, 60_000);
		await enqueueMergeFollowUp(job, 60_000);

		expect(add).toHaveBeenNthCalledWith(1, 'merge-follow-up', job, {
			jobId: 'merge-followup_run-1_4',
			delay: 60_000,
		});
		expect(add).toHaveBeenNthCalledWith(2, 'merge-follow-up', job, {
			jobId: 'merge-followup_run-1_4',
			delay: 60_000,
		});
	});

	it('gives a different run the same attempt number a distinct job id', async () => {
		const { enqueueMergeFollowUp } = await import('@/queue/merge-follow-up.js');
		await enqueueMergeFollowUp(
			{ projectId: 'p1', runId: 'run-a', prNumber: '1', approvedHeadSha: 'sha-a', attempt: 1 },
			15_000,
		);
		await enqueueMergeFollowUp(
			{ projectId: 'p1', runId: 'run-b', prNumber: '2', approvedHeadSha: 'sha-b', attempt: 1 },
			15_000,
		);

		const ids = add.mock.calls.map((call) => (call[2] as { jobId?: string })?.jobId);
		expect(new Set(ids).size).toBe(2);
	});
});

describe('closeMergeFollowUpQueue', () => {
	it('closes and clears the lazily-constructed queue so a later call reconstructs it', async () => {
		const close = vi.fn(async () => {});
		QueueMock.mockImplementationOnce(() => ({ add, close }));
		const { enqueueMergeFollowUp, closeMergeFollowUpQueue } = await import(
			'@/queue/merge-follow-up.js'
		);
		await enqueueMergeFollowUp(
			{ projectId: 'p1', runId: 'run-1', prNumber: '42', approvedHeadSha: 'sha-1', attempt: 1 },
			15_000,
		);

		await closeMergeFollowUpQueue();

		expect(close).toHaveBeenCalledOnce();
	});

	it('is a no-op when the queue was never constructed', async () => {
		const { closeMergeFollowUpQueue } = await import('@/queue/merge-follow-up.js');
		await expect(closeMergeFollowUpQueue()).resolves.toBeUndefined();
	});
});
