import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import { logger } from '@/lib/logger.js';
import type { MergePullRequestOutcome } from '@/scm/merge.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

let projectLookup: (id: string) => ProjectConfig | undefined;
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByIdFromDb: async (id: string) => projectLookup(id),
}));

const updateReviewMergeOutcome = vi.fn(async (_runId: string, _input: unknown) => true);
const getPendingReviewMergeFollowUps = vi.fn(async () => [] as unknown[]);
vi.mock('@/db/repositories/runsRepository.js', () => ({
	updateReviewMergeOutcome: (runId: string, input: unknown) =>
		updateReviewMergeOutcome(runId, input),
	getPendingReviewMergeFollowUps: () => getPendingReviewMergeFollowUps(),
}));

const mergePullRequest =
	vi.fn<(project: ProjectConfig, prNumber: number, approvedHeadSha: string) => Promise<unknown>>();
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		mergePullRequest = mergePullRequest;
	},
}));

const enqueueMergeFollowUp = vi.fn(async (_job: unknown, _delayMs: number) => {});
vi.mock('@/queue/merge-follow-up.js', () => ({
	enqueueMergeFollowUp: (job: unknown, delayMs: number) => enqueueMergeFollowUp(job, delayMs),
}));

import {
	MAX_MERGE_FOLLOW_UP_ATTEMPTS,
	mergeFollowUpDelayMs,
	processMergeFollowUp,
	recordReviewMergeOutcome,
	recoverPendingMergeFollowUps,
	scheduleMergeFollowUp,
} from '@/worker/merge-follow-up.js';

const PROJECT = createMockProjectConfig();

describe('mergeFollowUpDelayMs', () => {
	it('doubles from a 15s base and caps at 5 minutes', () => {
		expect(mergeFollowUpDelayMs(1)).toBe(15_000);
		expect(mergeFollowUpDelayMs(2)).toBe(30_000);
		expect(mergeFollowUpDelayMs(3)).toBe(60_000);
		expect(mergeFollowUpDelayMs(4)).toBe(120_000);
		expect(mergeFollowUpDelayMs(5)).toBe(240_000);
		expect(mergeFollowUpDelayMs(6)).toBe(300_000);
		expect(mergeFollowUpDelayMs(20)).toBe(300_000);
	});
});

describe('recordReviewMergeOutcome', () => {
	beforeEach(() => {
		updateReviewMergeOutcome.mockClear();
		enqueueMergeFollowUp.mockClear();
	});

	it('persists the immediate attempt (attempt 0) and schedules a follow-up when not-ready', async () => {
		await recordReviewMergeOutcome({
			projectId: 'proj-1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			outcome: { status: 'not-ready', message: 'pending checks' },
		});

		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'not-ready',
			message: 'pending checks',
			attempt: 0,
			approvedHeadSha: 'sha-1',
		});
		expect(enqueueMergeFollowUp).toHaveBeenCalledExactlyOnceWith(
			{ projectId: 'proj-1', runId: 'run-1', prNumber: '42', approvedHeadSha: 'sha-1', attempt: 1 },
			mergeFollowUpDelayMs(1),
		);
	});

	it('does not schedule a follow-up for a merged outcome', async () => {
		await recordReviewMergeOutcome({
			projectId: 'proj-1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			outcome: { status: 'merged', message: 'merged' },
		});

		expect(enqueueMergeFollowUp).not.toHaveBeenCalled();
	});

	it.each([
		'not-eligible',
		'policy-blocked',
		'unsupported',
		'provider-error',
	])('does not schedule a follow-up for a terminal %s outcome', async (status) => {
		await recordReviewMergeOutcome({
			projectId: 'proj-1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			outcome: { status, message: 'terminal' } as MergePullRequestOutcome,
		});

		expect(enqueueMergeFollowUp).not.toHaveBeenCalled();
	});

	it('still schedules a follow-up when persisting the outcome fails', async () => {
		updateReviewMergeOutcome.mockRejectedValueOnce(new Error('db down'));
		const error = vi.spyOn(logger, 'error');

		await recordReviewMergeOutcome({
			projectId: 'proj-1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			outcome: { status: 'not-ready', message: 'pending checks' },
		});

		expect(error).toHaveBeenCalled();
		expect(enqueueMergeFollowUp).toHaveBeenCalledOnce();
	});
});

describe('scheduleMergeFollowUp', () => {
	beforeEach(() => {
		updateReviewMergeOutcome.mockClear();
		enqueueMergeFollowUp.mockClear();
	});

	it('enqueues the next attempt with its backoff delay while inside the retry budget', async () => {
		await scheduleMergeFollowUp({
			projectId: 'proj-1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			attempt: 3,
		});

		expect(enqueueMergeFollowUp).toHaveBeenCalledExactlyOnceWith(
			{ projectId: 'proj-1', runId: 'run-1', prNumber: '42', approvedHeadSha: 'sha-1', attempt: 3 },
			mergeFollowUpDelayMs(3),
		);
		expect(updateReviewMergeOutcome).not.toHaveBeenCalled();
	});

	it('records retry-exhausted instead of scheduling once the attempt budget is spent', async () => {
		await scheduleMergeFollowUp({
			projectId: 'proj-1',
			runId: 'run-1',
			prNumber: '42',
			approvedHeadSha: 'sha-1',
			attempt: MAX_MERGE_FOLLOW_UP_ATTEMPTS + 1,
		});

		expect(enqueueMergeFollowUp).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith(
			'run-1',
			expect.objectContaining({ status: 'retry-exhausted', approvedHeadSha: 'sha-1' }),
		);
	});
});

describe('processMergeFollowUp', () => {
	beforeEach(() => {
		projectLookup = () => PROJECT;
		mergePullRequest.mockReset();
		updateReviewMergeOutcome.mockClear();
		enqueueMergeFollowUp.mockClear();
	});

	const job = {
		projectId: PROJECT.id,
		runId: 'run-1',
		prNumber: '42',
		approvedHeadSha: 'sha-1',
		attempt: 2,
	};

	it('skips the attempt when the project no longer resolves', async () => {
		projectLookup = () => undefined;

		await processMergeFollowUp(job);

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).not.toHaveBeenCalled();
	});

	it('re-invokes the provider with the current attempt’s approved head and persists a merged result', async () => {
		mergePullRequest.mockResolvedValue({ status: 'merged', message: 'merged on retry' });

		await processMergeFollowUp(job);

		expect(mergePullRequest).toHaveBeenCalledExactlyOnceWith(PROJECT, 42, 'sha-1');
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'merged',
			message: 'merged on retry',
			attempt: 2,
			approvedHeadSha: 'sha-1',
		});
		expect(enqueueMergeFollowUp).not.toHaveBeenCalled();
	});

	it('schedules the next attempt when still not-ready', async () => {
		mergePullRequest.mockResolvedValue({ status: 'not-ready', message: 'still pending' });

		await processMergeFollowUp(job);

		expect(enqueueMergeFollowUp).toHaveBeenCalledExactlyOnceWith(
			{
				projectId: PROJECT.id,
				runId: 'run-1',
				prNumber: '42',
				approvedHeadSha: 'sha-1',
				attempt: 3,
			},
			mergeFollowUpDelayMs(3),
		);
	});

	it.each([
		'not-eligible',
		'policy-blocked',
		'unsupported',
		'provider-error',
	])('persists a terminal %s outcome without scheduling another attempt', async (status) => {
		mergePullRequest.mockResolvedValue({ status, message: 'terminal' });

		await processMergeFollowUp(job);

		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status,
			message: 'terminal',
			attempt: 2,
			approvedHeadSha: 'sha-1',
		});
		expect(enqueueMergeFollowUp).not.toHaveBeenCalled();
	});

	it('normalizes a thrown rejection to a provider-error outcome', async () => {
		mergePullRequest.mockRejectedValue(new Error('adapter crashed'));

		await processMergeFollowUp(job);

		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith(
			'run-1',
			expect.objectContaining({ status: 'provider-error', message: 'adapter crashed' }),
		);
		expect(enqueueMergeFollowUp).not.toHaveBeenCalled();
	});
});

describe('recoverPendingMergeFollowUps', () => {
	beforeEach(() => {
		getPendingReviewMergeFollowUps.mockReset();
		enqueueMergeFollowUp.mockClear();
		updateReviewMergeOutcome.mockClear();
	});

	it('reschedules the next attempt for each recoverable pending run', async () => {
		getPendingReviewMergeFollowUps.mockResolvedValue([
			{
				id: 'run-1',
				projectId: 'proj-1',
				prNumber: '42',
				reviewMergeApprovedHeadSha: 'sha-1',
				reviewMergeAttempt: 2,
			},
		]);

		await recoverPendingMergeFollowUps();

		expect(enqueueMergeFollowUp).toHaveBeenCalledExactlyOnceWith(
			{ projectId: 'proj-1', runId: 'run-1', prNumber: '42', approvedHeadSha: 'sha-1', attempt: 3 },
			mergeFollowUpDelayMs(3),
		);
	});

	it('treats a missing attempt count as 0 so recovery resumes at attempt 1', async () => {
		getPendingReviewMergeFollowUps.mockResolvedValue([
			{
				id: 'run-2',
				projectId: 'proj-1',
				prNumber: '43',
				reviewMergeApprovedHeadSha: 'sha-2',
				reviewMergeAttempt: null,
			},
		]);

		await recoverPendingMergeFollowUps();

		expect(enqueueMergeFollowUp).toHaveBeenCalledExactlyOnceWith(
			{ projectId: 'proj-1', runId: 'run-2', prNumber: '43', approvedHeadSha: 'sha-2', attempt: 1 },
			mergeFollowUpDelayMs(1),
		);
	});

	it('skips a row missing the PR number or the approved head (nothing recoverable)', async () => {
		getPendingReviewMergeFollowUps.mockResolvedValue([
			{
				id: 'run-3',
				projectId: 'proj-1',
				prNumber: null,
				reviewMergeApprovedHeadSha: 'sha-3',
				reviewMergeAttempt: 0,
			},
			{
				id: 'run-4',
				projectId: 'proj-1',
				prNumber: '44',
				reviewMergeApprovedHeadSha: null,
				reviewMergeAttempt: 0,
			},
		]);

		await recoverPendingMergeFollowUps();

		expect(enqueueMergeFollowUp).not.toHaveBeenCalled();
	});

	it('swallows a lookup failure rather than throwing at startup', async () => {
		getPendingReviewMergeFollowUps.mockRejectedValue(new Error('db unavailable'));
		const error = vi.spyOn(logger, 'error');

		await expect(recoverPendingMergeFollowUps()).resolves.toBeUndefined();
		expect(error).toHaveBeenCalled();
	});
});
