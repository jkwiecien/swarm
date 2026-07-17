import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
} from '../../helpers/factories.js';

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

// The pending-continuation registry (issue #214): a prioritized continuation is
// registered here so a freed slot can promote it. Mocked at the boundary so the
// test needs no Redis and can assert what was registered.
const registerPendingContinuation = vi.fn(async (_projectId: string, _entry: unknown) => {});
vi.mock('@/worker/pending-continuations.js', () => ({
	registerPendingContinuation: (projectId: string, entry: unknown) =>
		registerPendingContinuation(projectId, entry),
}));

const { reenqueueDeferred } = await import('@/worker/deferred-retry.js');

describe('reenqueueDeferred', () => {
	beforeEach(() => {
		isRunCancellationRequested.mockReset();
		enqueueDelayedRetry.mockClear();
		enqueueDelayedRetry.mockResolvedValue('retry-1');
		removePendingRetryForRun.mockClear();
		registerPendingContinuation.mockClear();
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

	it('retries a concurrency-deferred Implementation as a fresh board dispatch', async () => {
		await reenqueueDeferred('job-1', createMockGitHubProjectsWebhookJob(), {
			status: 'phase-deferred',
			phase: 'implementation',
			taskId: '216',
			retryDelayMs: 60_000,
			reason: "Project 'swarm' is at its concurrent-job limit",
			attempt: 0,
			resumable: false,
		});

		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.not.objectContaining({ resumePmPhase: expect.anything(), resumeSession: true }),
			60_000,
		);
	});

	it('keeps PM resume and branch reuse for an interrupted Implementation', async () => {
		await reenqueueDeferred('job-1', createMockGitHubProjectsWebhookJob(), {
			status: 'phase-deferred',
			phase: 'implementation',
			taskId: '216',
			retryDelayMs: 60_000,
			reason: 'rate limited',
			attempt: 0,
			resumable: true,
			pmPhaseStarted: true,
			runId: 'run-1',
		});

		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.objectContaining({ resumePmPhase: 'implementation', resumeSession: true }),
			60_000,
		);
	});

	it('retries delivery with its own worktree-resume signal, not an agent session', async () => {
		await reenqueueDeferred('job-1', createMockGitHubWebhookJob(), {
			status: 'phase-deferred',
			phase: 'review',
			taskId: '243',
			retryDelayMs: 60_000,
			reason: 'review delivery failed',
			attempt: 0,
			resumable: false,
			resumeDelivery: true,
			runId: 'run-1',
		});

		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.objectContaining({ resumeDelivery: true }),
			60_000,
		);
		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.not.objectContaining({ resumeSession: true }),
			60_000,
		);
	});

	it('keeps manual PM retry dispatch intent through a later concurrency deferral', async () => {
		await reenqueueDeferred(
			'job-1',
			createMockGitHubProjectsWebhookJob({
				runId: 'run-1',
				resumePmPhase: 'implementation',
			}),
			{
				status: 'phase-deferred',
				phase: 'implementation',
				taskId: '216',
				retryDelayMs: 60_000,
				reason: "Project 'swarm' is at its concurrent-job limit",
				attempt: 1,
				resumable: false,
				runId: 'run-1',
			},
		);

		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.objectContaining({
				resumePmPhase: 'implementation',
				runId: 'run-1',
			}),
			60_000,
		);
		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.not.objectContaining({ implementationBranchProvisioned: true }),
			60_000,
		);
	});

	it('preserves an explicit branch checkpoint through concurrency deferral', async () => {
		await reenqueueDeferred(
			'job-1',
			createMockGitHubProjectsWebhookJob({
				runId: 'run-1',
				resumePmPhase: 'implementation',
				implementationBranchProvisioned: true,
			}),
			{
				status: 'phase-deferred',
				phase: 'implementation',
				taskId: '216',
				retryDelayMs: 60_000,
				reason: "Project 'swarm' is at its concurrent-job limit",
				attempt: 1,
				resumable: false,
				runId: 'run-1',
			},
		);

		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.objectContaining({
				resumePmPhase: 'implementation',
				implementationBranchProvisioned: true,
			}),
			60_000,
		);
	});

	it('threads continuationDispatchClaimed and registers a prioritized Review continuation', async () => {
		enqueueDelayedRetry.mockResolvedValue('retry-42');

		await reenqueueDeferred('job-1', createMockGitHubWebhookJob(), {
			status: 'phase-deferred',
			phase: 'review',
			taskId: '17',
			retryDelayMs: 6 * 60 * 1000,
			reason: "Project 'swarm' is at its concurrent-job limit",
			attempt: 0,
			resumable: false,
			runId: 'run-1',
			continuationDispatchClaimed: true,
			pendingContinuation: true,
		});

		// The retry carries the reuse-the-held-claim flag so its handler skips re-claiming.
		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.objectContaining({ continuationDispatchClaimed: true }),
			6 * 60 * 1000,
		);
		// It is registered under the project with the id enqueueDelayedRetry returned.
		expect(registerPendingContinuation).toHaveBeenCalledExactlyOnceWith('swarm', {
			jobId: 'retry-42',
			taskId: '17',
			phase: 'review',
			enqueuedAt: expect.any(Number),
		});
	});

	it('does not thread the flag or register when the outcome is not a pending continuation', async () => {
		await reenqueueDeferred('job-1', createMockGitHubWebhookJob(), {
			status: 'phase-deferred',
			phase: 'review',
			taskId: '17',
			retryDelayMs: 6 * 60 * 1000,
			reason: 'rate limited',
			attempt: 0,
			resumable: false,
			runId: 'run-1',
		});

		expect(enqueueDelayedRetry).toHaveBeenCalledWith(
			expect.not.objectContaining({ continuationDispatchClaimed: true }),
			6 * 60 * 1000,
		);
		expect(registerPendingContinuation).not.toHaveBeenCalled();
	});

	it('does not register a pending continuation for a run terminated in the enqueue window', async () => {
		// The retry was enqueued then removed by the terminator race; it must not be
		// registered as pending (it no longer exists).
		isRunCancellationRequested.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		await reenqueueDeferred('job-1', createMockGitHubWebhookJob(), {
			status: 'phase-deferred',
			phase: 'review',
			taskId: '17',
			retryDelayMs: 6 * 60 * 1000,
			reason: "Project 'swarm' is at its concurrent-job limit",
			attempt: 0,
			resumable: false,
			runId: 'run-1',
			continuationDispatchClaimed: true,
			pendingContinuation: true,
		});

		expect(removePendingRetryForRun).toHaveBeenCalledWith('run-1');
		expect(registerPendingContinuation).not.toHaveBeenCalled();
	});
});
