import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockGitHubWebhookJob } from '../../helpers/factories.js';

const isRunCancellationRequested = vi.fn<(runId: string) => Promise<boolean>>();
vi.mock('@/queue/cancellation.js', () => ({
	isRunCancellationRequested: (runId: string) => isRunCancellationRequested(runId),
}));

const enqueueDelayedRetry = vi.fn(async (_job: unknown, _delayMs: number) => 'retry-1');
const removePendingRetryForRun = vi.fn(async (_runId: string) => 1);
vi.mock('@/queue/producer.js', () => ({
	enqueueDelayedRetry: (job: unknown, delayMs: number) => enqueueDelayedRetry(job, delayMs),
	removePendingRetryForRun: (runId: string) => removePendingRetryForRun(runId),
}));

const { reenqueueDeferred } = await import('@/worker/deferred-retry.js');

describe('reenqueueDeferred', () => {
	beforeEach(() => {
		isRunCancellationRequested.mockReset();
		enqueueDelayedRetry.mockClear();
		removePendingRetryForRun.mockClear();
	});

	it('removes a retry when termination lands in the pre-enqueue window', async () => {
		// `processJob` has persisted `deferred`; the terminator sees no pending
		// BullMQ job, records cancellation, and fails the row before this handler
		// enqueues. The second lookup must remove that newly created retry.
		isRunCancellationRequested.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		await reenqueueDeferred('job-1', createMockGitHubWebhookJob(), {
			status: 'phase-deferred',
			phase: 'review',
			taskId: '17',
			retryDelayMs: 60_000,
			reason: 'rate limited',
			attempt: 0,
			resumable: false,
			runId: 'run-1',
		});

		expect(enqueueDelayedRetry).toHaveBeenCalledOnce();
		expect(removePendingRetryForRun).toHaveBeenCalledWith('run-1');
	});

	it('does not enqueue a retry for an already terminated run', async () => {
		isRunCancellationRequested.mockResolvedValue(true);

		await reenqueueDeferred('job-1', createMockGitHubWebhookJob(), {
			status: 'phase-deferred',
			phase: 'review',
			taskId: '17',
			retryDelayMs: 60_000,
			reason: 'rate limited',
			attempt: 0,
			resumable: false,
			runId: 'run-1',
		});

		expect(enqueueDelayedRetry).not.toHaveBeenCalled();
	});
});
