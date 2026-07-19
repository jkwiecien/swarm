import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	listRunsFromDb: vi.fn(),
	getRunByIdFromDb: vi.fn(),
	getRunLogsFromDb: vi.fn(),
	getRunOutputEvents: vi.fn(),
	markRunUserTerminated: vi.fn(),
	cancelDeferredRunInDb: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
}));

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	getActiveDispatchByRunId: vi.fn(),
	getDispatchById: vi.fn(),
	listWaitingDispatches: vi.fn(),
	reopenDispatchForManualRetry: vi.fn(),
}));

vi.mock('@/dispatch/dispatcher.js', () => ({
	cancelDispatchAndWake: vi.fn(),
	cancelDispatchForRun: vi.fn(),
	createAndPublishDispatch: vi.fn(),
	publishDispatchWakeUp: vi.fn(),
}));

vi.mock('@/integrations/pm/registry.js', () => ({
	getPMProvider: vi.fn(),
}));

vi.mock('@/queue/producer.js', () => ({
	priorityFor: (job: { type: string }) => (job.type === 'github-projects' ? 10 : undefined),
	removePendingJobById: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/queue/queued-runs.js', () => ({
	toQueuedRuns: vi.fn(),
	deriveQueuedPhaseHint: vi.fn((job) => {
		if (job.type === 'github-projects') return 'board';
		const { event } = job;
		if (event.eventType === 'pull_request_review') {
			return event.reviewState === 'approved' ? 'review' : 'respond-to-review';
		}
		if (event.eventType === 'pull_request' && event.action === 'closed' && event.merged === true) {
			return 'resolve-conflicts';
		}
		return 'unknown';
	}),
}));

vi.mock('@/queue/cancellation.js', () => ({
	requestRunCancellation: vi.fn(),
	clearRunCancellation: vi.fn(),
	RUN_CANCELLED_MESSAGE: 'Run cancelled after a cancellation request.',
}));

import { runsRouter } from '@/api/routers/runs.js';
import {
	type DispatchRow,
	getActiveDispatchByRunId,
	getDispatchById,
	listWaitingDispatches,
	reopenDispatchForManualRetry,
} from '@/db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
import {
	cancelDeferredRunInDb,
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
	listRunsFromDb,
	markRunUserTerminated,
} from '@/db/repositories/runsRepository.js';
import type { runs } from '@/db/schema/runs.js';
import {
	cancelDispatchAndWake,
	cancelDispatchForRun,
	createAndPublishDispatch,
	publishDispatchWakeUp,
} from '@/dispatch/dispatcher.js';
import { getPMProvider } from '@/integrations/pm/registry.js';
import {
	clearRunCancellation,
	RUN_CANCELLED_MESSAGE,
	requestRunCancellation,
} from '@/queue/cancellation.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { toQueuedRuns } from '@/queue/queued-runs.js';
import {
	createMockGitHubProjectsWebhookJob,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../../helpers/factories.js';

type RunRow = typeof runs.$inferSelect;

// Small local builder — no `createMockRun` factory exists and only these run
// tests need one, so it stays inline rather than expanding tests/helpers.
function makeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		projectId: 'p1',
		taskId: '103',
		workItemId: null,
		workItemTitle: null,
		workItemUrl: null,
		prNumber: null,
		prTitle: null,
		phase: 'implementation',
		engine: null,
		model: null,
		reasoning: null,
		status: 'completed',
		reviewVerdict: null,
		reviewOrdinal: null,
		reviewAutomationOutcome: null,
		reviewMergeOutcome: null,
		reviewMergeMessage: null,
		reviewMergeAttempt: null,
		reviewMergeApprovedHeadSha: null,
		exitCode: 0,
		timedOut: false,
		error: null,
		startedAt: new Date('2026-07-10T00:00:00Z'),
		completedAt: new Date('2026-07-10T00:01:00Z'),
		nextRetryAt: null,
		durationMs: 60000,
		timeoutMs: null,
		usage: null,
		delegations: null,
		jobPayload: null,
		agentSessionId: null,
		recovery: null,
		cancellation: null,
		outputBytes: 0,
		outputTruncated: false,
		...overrides,
	};
}

const GITHUB_PAYLOAD: SwarmJob = {
	type: 'github',
	projectId: 'p1',
	event: {
		eventType: 'pull_request',
		repoFullName: 'jkwiecien/swarm',
		isCommentEvent: false,
	},
};

function makeDispatch(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'p1',
		taskId: '103',
		phase: 'implementation',
		state: 'retry-scheduled',
		waitReason: 'rate-limit',
		outcome: null,
		dedupKey: null,
		coalesceKey: null,
		continuation: false,
		priority: 0,
		attempt: 1,
		wakeSeq: 1,
		availableAt: new Date('2026-07-10T00:30:00Z'),
		jobPayload: GITHUB_PAYLOAD,
		runId: 'run-1',
		leaseOwner: null,
		leaseExpiresAt: null,
		lastError: null,
		source: 'webhook',
		createdAt: new Date('2026-07-10T00:00:00Z'),
		updatedAt: new Date('2026-07-10T00:00:00Z'),
		completedAt: null,
		...overrides,
	};
}

describe('runsRouter', () => {
	const AUTHED_USER = {
		id: '00000000-0000-4000-8000-000000000000',
		identifier: 'tester@example.com',
		displayName: 'Tester',
		instanceAdmin: true,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const caller = runsRouter.createCaller({ user: AUTHED_USER });

	beforeEach(() => {
		vi.mocked(listRunsFromDb).mockReset();
		vi.mocked(getRunByIdFromDb).mockReset();
		vi.mocked(getRunLogsFromDb).mockReset();
		vi.mocked(getRunOutputEvents).mockReset();
		vi.mocked(cancelDeferredRunInDb).mockReset();
		vi.mocked(requestRunCancellation).mockReset();
		vi.mocked(clearRunCancellation).mockReset();
		vi.mocked(toQueuedRuns).mockReset();
		vi.mocked(getProjectByIdFromDb).mockReset();
		vi.mocked(getPMProvider).mockReset();
		vi.mocked(getActiveDispatchByRunId).mockReset();
		vi.mocked(getDispatchById).mockReset();
		vi.mocked(listWaitingDispatches).mockReset();
		vi.mocked(listWaitingDispatches).mockResolvedValue([]);
		vi.mocked(reopenDispatchForManualRetry).mockReset();
		vi.mocked(cancelDispatchAndWake).mockReset();
		vi.mocked(cancelDispatchForRun).mockReset();
		vi.mocked(createAndPublishDispatch).mockReset();
		vi.mocked(publishDispatchWakeUp).mockReset();
	});

	describe('list', () => {
		it('returns whatever listRunsFromDb resolves and applies default pagination', async () => {
			const nextRetryAt = new Date('2026-07-10T00:30:00Z');
			const data = [
				makeRun({
					id: 'run-1',
					nextRetryAt,
					workItemTitle: 'Fix the widget',
					workItemUrl: 'https://github.com/acme/widgets/issues/103',
				}),
				makeRun({ id: 'run-2' }),
			];
			vi.mocked(listRunsFromDb).mockResolvedValue({ data, total: 2 });

			const result = await caller.list({});
			expect(result).toEqual({ data, total: 2 });
			expect(result.data[0].nextRetryAt).toEqual(nextRetryAt);
			expect(listRunsFromDb).toHaveBeenCalledWith({ limit: 50, offset: 0 });
		});

		it('exposes a completed Review run’s verdict in the list data shape (issue #218)', async () => {
			const data = [
				makeRun({ id: 'run-1', phase: 'review', status: 'completed', reviewVerdict: 'approve' }),
			];
			vi.mocked(listRunsFromDb).mockResolvedValue({ data, total: 1 });

			const result = await caller.list({ phase: 'review' });
			expect(result.data[0].reviewVerdict).toBe('approve');
		});

		it('passes filters and pagination through unchanged', async () => {
			vi.mocked(listRunsFromDb).mockResolvedValue({ data: [], total: 0 });

			await caller.list({
				projectId: 'p1',
				status: 'failed',
				phase: 'review',
				limit: 10,
				offset: 20,
			});

			expect(listRunsFromDb).toHaveBeenCalledWith({
				projectId: 'p1',
				status: 'failed',
				phase: 'review',
				limit: 10,
				offset: 20,
			});
		});

		it('returns an empty result set', async () => {
			vi.mocked(listRunsFromDb).mockResolvedValue({ data: [], total: 0 });

			const result = await caller.list({});
			expect(result).toEqual({ data: [], total: 0 });
		});

		it('rejects an invalid status enum value at the boundary', async () => {
			await expect(caller.list({ status: 'exploded' as never })).rejects.toThrow();
			expect(listRunsFromDb).not.toHaveBeenCalled();
		});

		it('rejects an invalid phase enum value at the boundary', async () => {
			await expect(caller.list({ phase: 'deploy' as never })).rejects.toThrow();
			expect(listRunsFromDb).not.toHaveBeenCalled();
		});
	});

	describe('queued', () => {
		it('reads canonical waiting dispatches and enriches board jobs with backing metadata', async () => {
			const queuedItem = {
				jobId: 'dispatch-board',
				projectId: 'p1',
				type: 'github-projects' as const,
				state: 'prioritized' as const,
				phaseHint: 'board' as const,
				workItemNodeId: 'PVTI_item',
				contentType: 'Issue',
				priority: 10,
				enqueuedAt: '2026-07-17T10:00:00.000Z',
			};
			const workItem = createMockWorkItem({
				title: 'Fix the widget',
				url: 'https://github.com/acme/widgets/issues/42',
				statusId: '61e4505c', // Planning status
			});
			const getWorkItem = vi.fn().mockResolvedValue(workItem);
			vi.mocked(toQueuedRuns).mockReturnValue([queuedItem]);
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(getPMProvider).mockReturnValue({
				createProvider: () => ({ getWorkItem }),
			} as never);

			const result = await caller.queued({});

			expect(result).toEqual([
				{
					...queuedItem,
					workItemTitle: 'Fix the widget',
					workItemUrl: 'https://github.com/acme/widgets/issues/42',
				},
			]);
			expect(listWaitingDispatches).toHaveBeenCalledWith(undefined);
			expect(getProjectByIdFromDb).toHaveBeenCalledWith('p1');
			expect(getPMProvider).toHaveBeenCalledWith('github-projects');
			expect(getWorkItem).toHaveBeenCalledWith('PVTI_item');
		});

		it('scopes the dispatch query to the requested project', async () => {
			vi.mocked(toQueuedRuns).mockReturnValue([]);

			await caller.queued({ projectId: 'p1' });

			expect(listWaitingDispatches).toHaveBeenCalledWith('p1');
		});

		it('returns the queued item when backing metadata cannot be resolved', async () => {
			const queuedItem = {
				jobId: 'dispatch-board-missing',
				projectId: 'missing-project',
				type: 'github-projects' as const,
				state: 'prioritized' as const,
				phaseHint: 'board' as const,
				workItemNodeId: 'PVTI_missing',
				priority: 10,
				enqueuedAt: '2026-07-17T10:00:00.000Z',
			};
			vi.mocked(toQueuedRuns).mockReturnValue([queuedItem]);
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			expect(await caller.queued({})).toEqual([queuedItem]);
		});

		it('passes reviewGate metadata through unchanged alongside normal github enrichment (issue #275)', async () => {
			const queuedItem = {
				jobId: 'dispatch-review-gate',
				projectId: 'p1',
				type: 'github' as const,
				state: 'waiting' as const,
				phaseHint: 'review' as const,
				repo: 'acme/widgets',
				prNumber: '42',
				priority: 0,
				enqueuedAt: '2026-07-17T10:00:00.000Z',
				reviewGate: {
					sourceEvent: 'check_suite' as const,
					sourceAction: 'completed',
					headSha: 'sha-fix',
				},
			};
			vi.mocked(toQueuedRuns).mockReturnValue([queuedItem]);
			// No project on file — enrichment can't resolve a backing work item, so
			// the item (reviewGate included) is returned exactly as the read model built it.
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			expect(await caller.queued({})).toEqual([queuedItem]);
		});
	});

	describe('getById', () => {
		it('returns the run when getRunByIdFromDb resolves one', async () => {
			const nextRetryAt = new Date('2026-07-10T00:30:00Z');
			const run = makeRun({
				id: 'run-1',
				nextRetryAt,
				workItemTitle: 'Fix the widget',
				workItemUrl: 'https://github.com/acme/widgets/issues/103',
			});
			vi.mocked(getRunByIdFromDb).mockResolvedValue(run);

			const result = await caller.getById({ id: 'run-1' });
			expect(result).toEqual(run);
			expect(result.nextRetryAt).toEqual(nextRetryAt);
			expect(getRunByIdFromDb).toHaveBeenCalledWith('run-1');
		});

		it('throws NOT_FOUND when getRunByIdFromDb resolves undefined', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.getById({ id: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Run with ID "missing" not found',
				}),
			);
		});
	});

	describe('getLogs', () => {
		it('returns the captured stdout/stderr when getRunLogsFromDb resolves logs', async () => {
			const logs = { stdout: 'out', stderr: 'err' };
			vi.mocked(getRunLogsFromDb).mockResolvedValue(logs);

			const result = await caller.getLogs({ runId: 'run-1' });
			expect(result).toEqual(logs);
			expect(getRunLogsFromDb).toHaveBeenCalledWith('run-1');
		});

		it('returns null (not an error) when the run stored no logs', async () => {
			vi.mocked(getRunLogsFromDb).mockResolvedValue(undefined);

			const result = await caller.getLogs({ runId: 'run-1' });
			expect(result).toBeNull();
		});
	});

	describe('getOutput', () => {
		it('passes the cursor through and returns the incremental page', async () => {
			const page = {
				events: [{ id: 8, stream: 'stderr' as const, content: 'warning\n', emittedAt: new Date() }],
				nextCursor: 8,
				hasMore: false,
				truncated: false,
				retentionBytes: 5_000_000,
			};
			vi.mocked(getRunOutputEvents).mockResolvedValue(page);

			await expect(caller.getOutput({ runId: 'run-1', after: 7 })).resolves.toEqual(page);
			expect(getRunOutputEvents).toHaveBeenCalledWith('run-1', 7);
		});
	});

	describe('retryNow', () => {
		it('re-opens the active dispatch for an immediate attempt on a deferred run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({
					id: 'run-1',
					status: 'deferred',
					agentSessionId: 'a1b2c3d4-0000-0000-0000-000000000000',
				}),
			);
			const dispatch = makeDispatch();
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(dispatch);
			const reopened = makeDispatch({ state: 'pending', waitReason: 'manual-retry', attempt: 0 });
			vi.mocked(reopenDispatchForManualRetry).mockResolvedValue(reopened);

			const result = await caller.retryNow({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'retrying' });
			expect(reopenDispatchForManualRetry).toHaveBeenCalledWith(
				'dispatch-1',
				expect.objectContaining({ runId: 'run-1', rateLimitRetryAttempt: 0 }),
			);
			expect(publishDispatchWakeUp).toHaveBeenCalledWith(reopened);
			// The run row is NOT flipped here — it becomes `running` only when the
			// worker actually claims the dispatch (issue #284's false-running guard).
			expect(markRunUserTerminated).not.toHaveBeenCalled();
		});

		it('folds cli/model/reasoning overrides into the dispatch payload', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({
					id: 'run-1',
					status: 'deferred',
					agentSessionId: 'a1b2c3d4-0000-0000-0000-000000000000',
				}),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
			vi.mocked(reopenDispatchForManualRetry).mockResolvedValue(makeDispatch());

			await caller.retryNow({
				runId: 'run-1',
				cli: 'antigravity',
				model: 'gemini-3.5-flash',
				reasoning: 'high',
			});

			expect(reopenDispatchForManualRetry).toHaveBeenCalledWith(
				'dispatch-1',
				expect.objectContaining({
					cliOverride: 'antigravity',
					modelOverride: 'gemini-3.5-flash',
					reasoningOverride: 'high',
				}),
			);
		});

		it('creates a fresh dispatch with overrides for a failed run if jobPayload is present', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'failed', jobPayload: GITHUB_PAYLOAD }),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(undefined);
			vi.mocked(createAndPublishDispatch).mockResolvedValue({
				dispatch: makeDispatch(),
				created: true,
			});

			const result = await caller.retryNow({
				runId: 'run-1',
				cli: 'antigravity',
				model: 'gemini-3.5-flash',
				reasoning: 'high',
			});

			expect(result).toEqual({ runId: 'run-1', status: 'retrying' });
			expect(createAndPublishDispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: 'p1',
					source: 'manual',
					waitReason: 'manual-retry',
					runId: 'run-1',
					jobPayload: expect.objectContaining({
						cliOverride: 'antigravity',
						modelOverride: 'gemini-3.5-flash',
						reasoningOverride: 'high',
						runId: 'run-1',
						rateLimitRetryAttempt: 0,
					}),
				}),
			);
		});

		it('assigns a new session for a failed retry instead of reusing its old one', async () => {
			const mockPayload: SwarmJob = {
				...GITHUB_PAYLOAD,
				agentSessionId: '11111111-1111-4111-8111-111111111111',
				resumeSession: true,
			};
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'failed', jobPayload: mockPayload }),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(undefined);
			vi.mocked(createAndPublishDispatch).mockResolvedValue({
				dispatch: makeDispatch(),
				created: true,
			});

			await caller.retryNow({ runId: 'run-1' });

			const input = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
			expect(input.jobPayload.agentSessionId).not.toBe('11111111-1111-4111-8111-111111111111');
			expect(input.jobPayload.resumeSession).toBeUndefined();
		});

		it('marks a failed PM retry for dispatch without inventing a branch checkpoint', async () => {
			const mockPayload = createMockGitHubProjectsWebhookJob();
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'failed', jobPayload: mockPayload }),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(undefined);
			vi.mocked(createAndPublishDispatch).mockResolvedValue({
				dispatch: makeDispatch(),
				created: true,
			});

			await caller.retryNow({ runId: 'run-1' });

			const input = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
			expect(input.jobPayload).toMatchObject({ runId: 'run-1', resumePmPhase: 'implementation' });
			expect(input.jobPayload.implementationBranchProvisioned).toBeUndefined();
		});

		it('rejects a failed run if jobPayload is missing', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'failed', jobPayload: null }),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(undefined);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
			);
			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('throws NOT_FOUND for an unknown run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.retryNow({ runId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({ code: 'NOT_FOUND' }),
			);
			expect(getActiveDispatchByRunId).not.toHaveBeenCalled();
		});

		it('rejects a non-deferred non-failed run with PRECONDITION_FAILED (retryable-state guard)', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'completed' }));

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
			);
			expect(getActiveDispatchByRunId).not.toHaveBeenCalled();
		});

		it('retries even after the automatic budget was exhausted (bypasses the cap)', async () => {
			// A run can defer at a high attempt and still be manually retryable — the
			// reopen resets the counter. Guard: a deferred run always retries.
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(
				makeDispatch({ attempt: 6, jobPayload: { ...GITHUB_PAYLOAD, rateLimitRetryAttempt: 6 } }),
			);
			vi.mocked(reopenDispatchForManualRetry).mockResolvedValue(makeDispatch());

			await expect(caller.retryNow({ runId: 'run-1' })).resolves.toMatchObject({
				status: 'retrying',
			});
			expect(reopenDispatchForManualRetry).toHaveBeenCalledWith(
				'dispatch-1',
				expect.objectContaining({ rateLimitRetryAttempt: 0 }),
			);
		});

		it('reconstructs from jobPayload when a deferred run has no active dispatch (legacy orphan)', async () => {
			const mockPayload: SwarmJob = { ...GITHUB_PAYLOAD, resumeDelivery: true };
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'deferred', jobPayload: mockPayload }),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(undefined);
			vi.mocked(createAndPublishDispatch).mockResolvedValue({
				dispatch: makeDispatch(),
				created: true,
			});

			const result = await caller.retryNow({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'retrying' });
			expect(createAndPublishDispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: 'run-1',
					jobPayload: expect.objectContaining({ resumeDelivery: true, rateLimitRetryAttempt: 0 }),
				}),
			);
		});

		it('rejects a deferred run with no active dispatch and no jobPayload', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'deferred', jobPayload: null }),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(undefined);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
			);
			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('rejects with CONFLICT when the dispatch was claimed before the reopen landed', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ status: 'deferred' }));
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
			vi.mocked(reopenDispatchForManualRetry).mockResolvedValue(null);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'CONFLICT' }),
			);
			expect(publishDispatchWakeUp).not.toHaveBeenCalled();
		});

		it('rejects with CONFLICT when a concurrent retry already created the run’s dispatch', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ status: 'failed', jobPayload: GITHUB_PAYLOAD }),
			);
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(undefined);
			vi.mocked(createAndPublishDispatch).mockRejectedValue(
				new Error('duplicate key value violates unique constraint "uq_dispatches_active_run"'),
			);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'CONFLICT' }),
			);
		});

		it('still reports retrying when the wake-up publish fails (reconciler repairs it)', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
			vi.mocked(reopenDispatchForManualRetry).mockResolvedValue(makeDispatch());
			vi.mocked(publishDispatchWakeUp).mockRejectedValue(new Error('redis down'));

			await expect(caller.retryNow({ runId: 'run-1' })).resolves.toEqual({
				runId: 'run-1',
				status: 'retrying',
			});
		});

		it('clears a stale user-termination flag before re-running the row', async () => {
			// A run terminated while deferred keeps its cancellation entry; retrying
			// reuses the same run id, so the flag must be cleared or the worker would
			// instantly terminate the fresh attempt (issue #166).
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
			vi.mocked(reopenDispatchForManualRetry).mockResolvedValue(makeDispatch());

			await caller.retryNow({ runId: 'run-1' });

			expect(clearRunCancellation).toHaveBeenCalledWith('run-1');
		});
	});

	describe('terminate', () => {
		it('throws NOT_FOUND for an unknown run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.terminate({ runId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({ code: 'NOT_FOUND' }),
			);
			expect(requestRunCancellation).not.toHaveBeenCalled();
		});

		it('is a no-op returning the settled state for an already-completed run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'completed' }));

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'completed' });
			expect(requestRunCancellation).not.toHaveBeenCalled();
		});

		it('is a no-op returning the settled state for an already-failed run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'failed' }));

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'failed' });
			expect(requestRunCancellation).not.toHaveBeenCalled();
		});

		it('requests cancellation and reports terminating for a running run (worker settles the row)', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'running' }));

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'terminating' });
			// The one supported termination action always records its origin (issue
			// #308) — `source: 'dashboard'`, no `actor` (tRPC has no auth context).
			expect(requestRunCancellation).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({ source: 'dashboard', requestedAt: expect.any(String) }),
			);
			expect(vi.mocked(requestRunCancellation).mock.calls[0][1]).not.toHaveProperty('actor');
			// The worker owns an in-flight run's terminal state — the mutation must not
			// write the row itself, nor cancel the (running) dispatch out from under it.
			expect(markRunUserTerminated).not.toHaveBeenCalled();
			expect(cancelDispatchForRun).not.toHaveBeenCalled();
		});

		it('cancels the canonical dispatch and fails the row for a deferred run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(cancelDeferredRunInDb).mockResolvedValue({
				success: true,
				dispatch: { id: 'disp-1', wakeSeq: 2 },
			});

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'failed' });
			const origin = expect.objectContaining({ source: 'dashboard' });
			expect(requestRunCancellation).toHaveBeenCalledWith('run-1', origin);
			// The same origin just recorded in Redis is persisted on the row too.
			expect(cancelDeferredRunInDb).toHaveBeenCalledWith('run-1', RUN_CANCELLED_MESSAGE, origin);
			// Keep the marker until an explicit retry clears it: a wake-up that
			// already claimed the dispatch honours it at run start.
			expect(clearRunCancellation).not.toHaveBeenCalled();
		});

		it('falls back to the worker path when a deferred run was picked up concurrently', async () => {
			// The conditional deferred→failed loses the race (returns false): the row is
			// now running. Re-read shows running → report terminating; the flag we set
			// drives the worker to terminate it.
			vi.mocked(getRunByIdFromDb)
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'deferred' }))
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'running' }));
			vi.mocked(cancelDeferredRunInDb).mockResolvedValue({ success: false, dispatch: null });

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'terminating' });
			expect(requestRunCancellation).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({ source: 'dashboard' }),
			);
			expect(clearRunCancellation).not.toHaveBeenCalled();
		});

		it('returns the settled state when a deferred run settled during termination', async () => {
			// The conditional lost the race and the re-read shows the run already
			// terminal (a concurrent pickup completed it) — report that, don't error.
			vi.mocked(getRunByIdFromDb)
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'deferred' }))
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'completed' }));
			vi.mocked(cancelDeferredRunInDb).mockResolvedValue({ success: false, dispatch: null });

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'completed' });
		});
	});

	describe('putBack', () => {
		it('cancels a waiting github-projects dispatch and moves its card to backlog', async () => {
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			const jobData = createMockGitHubProjectsWebhookJob({ projectId: 'p1' });
			const dispatch = makeDispatch({ state: 'pending', jobPayload: jobData, runId: null });
			vi.mocked(getDispatchById).mockResolvedValue(dispatch);
			vi.mocked(cancelDispatchAndWake).mockResolvedValue(dispatch);

			const getWorkItem = vi.fn().mockResolvedValue({
				id: jobData.event.itemNodeId,
				statusId: '61e4505c', // Planning status (starts planning phase)
				title: 'Test Card',
				url: 'https://github.com/acme/widgets/issues/1',
			});
			const moveWorkItem = vi.fn().mockResolvedValue(undefined);
			vi.mocked(getPMProvider).mockReturnValue({
				createProvider: () => ({ getWorkItem, moveWorkItem }),
			} as never);

			const result = await caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' });

			expect(result).toEqual({ success: true });
			expect(getDispatchById).toHaveBeenCalledWith('dispatch-1');
			expect(cancelDispatchAndWake).toHaveBeenCalledWith('dispatch-1', expect.any(String));
			expect(getWorkItem).toHaveBeenCalledWith(jobData.event.itemNodeId);
			expect(moveWorkItem).toHaveBeenCalledWith(jobData.event.itemNodeId, 'backlog');
		});

		it('cancels a github dispatch and moves the card found by its url', async () => {
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			const jobData = {
				projectId: 'p1',
				type: 'github' as const,
				event: {
					eventType: 'pull_request_review' as const,
					reviewState: 'approved',
					repoFullName: 'acme/widgets',
					workItemId: '42',
					isCommentEvent: false,
				},
			};
			const dispatch = makeDispatch({
				state: 'pending',
				jobPayload: jobData as never,
				runId: null,
			});
			vi.mocked(getDispatchById).mockResolvedValue(dispatch);
			vi.mocked(cancelDispatchAndWake).mockResolvedValue(dispatch);

			const listWorkItems = vi
				.fn()
				.mockResolvedValue([{ id: 'card-1', url: 'https://github.com/acme/widgets/pull/42' }]);
			const moveWorkItem = vi.fn().mockResolvedValue(undefined);
			vi.mocked(getPMProvider).mockReturnValue({
				createProvider: () => ({ listWorkItems, moveWorkItem }),
			} as never);

			const result = await caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' });

			expect(result).toEqual({ success: true });
			expect(listWorkItems).toHaveBeenCalled();
			expect(moveWorkItem).toHaveBeenCalledWith('card-1', 'backlog');
		});

		it('throws NOT_FOUND when the project does not exist', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' })).rejects.toThrow(
				/Project with ID "p1" not found/,
			);
		});

		it('throws NOT_FOUND when the dispatch does not exist', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(getDispatchById).mockResolvedValue(undefined);

			await expect(caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' })).rejects.toThrow(
				/not found/,
			);
		});

		it('throws PRECONDITION_FAILED when the dispatch is already claimed (running)', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(getDispatchById).mockResolvedValue(makeDispatch({ state: 'running' }));

			await expect(caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' })).rejects.toThrow(
				/is running and cannot be put back/,
			);
			expect(cancelDispatchAndWake).not.toHaveBeenCalled();
		});

		it('throws PRECONDITION_FAILED when the job is in an unsupported phase', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			const jobData = {
				projectId: 'p1',
				type: 'github' as const,
				event: {
					eventType: 'pull_request' as const,
					action: 'closed',
					merged: true,
					repoFullName: 'acme/widgets',
					workItemId: '42',
					isCommentEvent: false,
				},
			};
			vi.mocked(getDispatchById).mockResolvedValue(
				makeDispatch({ state: 'pending', phase: null, jobPayload: jobData as never }),
			);

			await expect(caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' })).rejects.toThrow(
				/Job phase hint "resolve-conflicts" is not supported for Put back./,
			);
		});

		it('throws PRECONDITION_FAILED when the job has no linked card', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			const jobData = {
				projectId: 'p1',
				type: 'github' as const,
				event: {
					eventType: 'pull_request_review' as const,
					reviewState: 'approved',
					repoFullName: 'acme/widgets',
					workItemId: '42',
					isCommentEvent: false,
				},
			};
			vi.mocked(getDispatchById).mockResolvedValue(
				makeDispatch({ state: 'pending', phase: null, jobPayload: jobData as never }),
			);

			const listWorkItems = vi
				.fn()
				.mockResolvedValue([{ id: 'card-1', url: 'https://github.com/acme/widgets/pull/999' }]);
			vi.mocked(getPMProvider).mockReturnValue({
				createProvider: () => ({ listWorkItems }),
			} as never);

			await expect(caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' })).rejects.toThrow(
				/Job has no linked board card./,
			);
			expect(cancelDispatchAndWake).not.toHaveBeenCalled();
		});

		it('throws PRECONDITION_FAILED when the github-projects job status does not start planning or implementation', async () => {
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			const jobData = createMockGitHubProjectsWebhookJob({ projectId: 'p1' });
			vi.mocked(getDispatchById).mockResolvedValue(
				makeDispatch({ state: 'pending', jobPayload: jobData }),
			);

			const getWorkItem = vi.fn().mockResolvedValue({
				id: jobData.event.itemNodeId,
				statusId: 'df73e18b', // In Review status (does not start planning or implementation)
				title: 'Test Card',
				url: 'https://github.com/acme/widgets/issues/1',
			});
			vi.mocked(getPMProvider).mockReturnValue({
				createProvider: () => ({ getWorkItem }),
			} as never);

			await expect(caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' })).rejects.toThrow(
				/Work item status does not start a Planning or Implementation phase./,
			);
		});

		it('surfaces a claimed-in-the-meantime dispatch instead of moving the card', async () => {
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			const jobData = createMockGitHubProjectsWebhookJob({ projectId: 'p1' });
			vi.mocked(getDispatchById).mockResolvedValue(
				makeDispatch({ state: 'pending', jobPayload: jobData }),
			);
			vi.mocked(cancelDispatchAndWake).mockResolvedValue(null);

			const getWorkItem = vi.fn().mockResolvedValue({
				id: jobData.event.itemNodeId,
				statusId: '61e4505c',
				title: 'Test Card',
				url: 'https://github.com/acme/widgets/issues/1',
			});
			const moveWorkItem = vi.fn().mockResolvedValue(undefined);
			vi.mocked(getPMProvider).mockReturnValue({
				createProvider: () => ({ getWorkItem, moveWorkItem }),
			} as never);

			await expect(caller.putBack({ jobId: 'dispatch-1', projectId: 'p1' })).rejects.toThrow(
				/picked up while putting it back/,
			);
			expect(moveWorkItem).not.toHaveBeenCalled();
		});
	});
});
