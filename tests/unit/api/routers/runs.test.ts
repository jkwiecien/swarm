import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	listRunsFromDb: vi.fn(),
	getRunByIdFromDb: vi.fn(),
	getRunLogsFromDb: vi.fn(),
	resetRunToRunning: vi.fn(),
	markRunUserTerminated: vi.fn(),
}));

vi.mock('@/queue/producer.js', () => ({
	promoteRetryForRun: vi.fn(),
	enqueueDelayedRetry: vi.fn(),
	removePendingRetryForRun: vi.fn(),
}));

vi.mock('@/queue/cancellation.js', () => ({
	requestRunCancellation: vi.fn(),
	clearRunCancellation: vi.fn(),
	USER_TERMINATION_MESSAGE: 'Run terminated by user from the dashboard.',
}));

import { runsRouter } from '@/api/routers/runs.js';
import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	listRunsFromDb,
	markRunUserTerminated,
	resetRunToRunning,
} from '@/db/repositories/runsRepository.js';
import type { runs } from '@/db/schema/runs.js';
import {
	clearRunCancellation,
	requestRunCancellation,
	USER_TERMINATION_MESSAGE,
} from '@/queue/cancellation.js';
import {
	enqueueDelayedRetry,
	promoteRetryForRun,
	removePendingRetryForRun,
} from '@/queue/producer.js';

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
		status: 'completed',
		exitCode: 0,
		timedOut: false,
		error: null,
		startedAt: new Date('2026-07-10T00:00:00Z'),
		completedAt: new Date('2026-07-10T00:01:00Z'),
		nextRetryAt: null,
		durationMs: 60000,
		usage: null,
		jobPayload: null,
		agentSessionId: null,
		...overrides,
	};
}

describe('runsRouter', () => {
	const caller = runsRouter.createCaller({});

	beforeEach(() => {
		vi.mocked(listRunsFromDb).mockReset();
		vi.mocked(getRunByIdFromDb).mockReset();
		vi.mocked(getRunLogsFromDb).mockReset();
		vi.mocked(promoteRetryForRun).mockReset();
		vi.mocked(resetRunToRunning).mockReset();
		vi.mocked(enqueueDelayedRetry).mockReset();
		vi.mocked(markRunUserTerminated).mockReset();
		vi.mocked(removePendingRetryForRun).mockReset();
		vi.mocked(requestRunCancellation).mockReset();
		vi.mocked(clearRunCancellation).mockReset();
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
			await expect(
				// biome-ignore lint/suspicious/noExplicitAny: exercising invalid input
				caller.list({ status: 'bogus' as any }),
			).rejects.toThrow();
			expect(listRunsFromDb).not.toHaveBeenCalled();
		});

		it('rejects an invalid phase enum value at the boundary', async () => {
			await expect(
				// biome-ignore lint/suspicious/noExplicitAny: exercising invalid input
				caller.list({ phase: 'bogus' as any }),
			).rejects.toThrow();
			expect(listRunsFromDb).not.toHaveBeenCalled();
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

	describe('retryNow', () => {
		it('promotes the pending retry and reports the run as retrying for a deferred run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(resetRunToRunning).mockResolvedValue(true);
			vi.mocked(promoteRetryForRun).mockResolvedValue(true);

			const result = await caller.retryNow({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'retrying' });
			expect(resetRunToRunning).toHaveBeenCalledWith('run-1', undefined, 'deferred', undefined);
			expect(promoteRetryForRun).toHaveBeenCalledWith('run-1', undefined, undefined);
		});

		it('promotes the pending retry with cli and model overrides for a deferred run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(resetRunToRunning).mockResolvedValue(true);
			vi.mocked(promoteRetryForRun).mockResolvedValue(true);

			const result = await caller.retryNow({
				runId: 'run-1',
				cli: 'antigravity',
				model: 'Gemini 3.5 Flash (High)',
			});

			expect(result).toEqual({ runId: 'run-1', status: 'retrying' });
			expect(promoteRetryForRun).toHaveBeenCalledWith(
				'run-1',
				'antigravity',
				'Gemini 3.5 Flash (High)',
			);
		});

		it('enqueues a fresh job with overrides for a failed run if jobPayload is present', async () => {
			const mockPayload = {
				type: 'github' as const,
				projectId: 'p1',
				event: {
					eventType: 'pull_request' as const,
					repoFullName: 'jkwiecien/swarm',
					isCommentEvent: false,
				},
			};
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'failed', jobPayload: mockPayload }),
			);
			vi.mocked(resetRunToRunning).mockResolvedValue(true);
			vi.mocked(enqueueDelayedRetry).mockResolvedValue('job-1');

			const result = await caller.retryNow({
				runId: 'run-1',
				cli: 'antigravity',
				model: 'Gemini 3.5 Flash (High)',
			});

			expect(result).toEqual({ runId: 'run-1', status: 'retrying' });
			expect(resetRunToRunning).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({
					cliOverride: 'antigravity',
					modelOverride: 'Gemini 3.5 Flash (High)',
					runId: 'run-1',
				}),
				'failed',
				'Gemini 3.5 Flash (High)',
			);
			expect(enqueueDelayedRetry).toHaveBeenCalledWith(
				expect.objectContaining({
					cliOverride: 'antigravity',
					modelOverride: 'Gemini 3.5 Flash (High)',
					runId: 'run-1',
				}),
				0,
			);
		});

		it('rejects a failed run if jobPayload is missing', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'failed', jobPayload: null }),
			);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
			);
			expect(enqueueDelayedRetry).not.toHaveBeenCalled();
		});

		it('throws NOT_FOUND for an unknown run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.retryNow({ runId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({ code: 'NOT_FOUND' }),
			);
			expect(promoteRetryForRun).not.toHaveBeenCalled();
		});

		it('rejects a non-deferred non-failed run with PRECONDITION_FAILED (retryable-state guard)', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'completed' }));

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
			);
			expect(promoteRetryForRun).not.toHaveBeenCalled();
		});

		it('retries even after the automatic budget was exhausted (bypasses the cap)', async () => {
			// A run can defer at a high attempt and still be manually retryable — the
			// router doesn't inspect the attempt count, it just promotes the pending
			// job (which resets the counter). Guard: a deferred run always retries.
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(resetRunToRunning).mockResolvedValue(true);
			vi.mocked(promoteRetryForRun).mockResolvedValue(true);

			await expect(caller.retryNow({ runId: 'run-1' })).resolves.toMatchObject({
				status: 'retrying',
			});
		});

		it('reconstructs from jobPayload when a deferred run has no pending retry to promote', async () => {
			// The pending BullMQ retry can be lost (the fire-and-forget window on
			// worker shutdown, or the completed job reaped from Redis), leaving a
			// `deferred` row with no job to promote. Rather than a dead-end CONFLICT,
			// retryNow falls back to reconstructing the job from the stored payload —
			// the same path a terminally-`failed` run takes.
			const mockPayload = {
				type: 'github' as const,
				projectId: 'p1',
				event: {
					eventType: 'pull_request' as const,
					repoFullName: 'jkwiecien/swarm',
					isCommentEvent: false,
				},
			};
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'deferred', jobPayload: mockPayload }),
			);
			vi.mocked(promoteRetryForRun).mockResolvedValue(false);
			vi.mocked(resetRunToRunning).mockResolvedValue(true);
			vi.mocked(enqueueDelayedRetry).mockResolvedValue('job-1');

			const result = await caller.retryNow({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'retrying' });
			expect(resetRunToRunning).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({ runId: 'run-1', rateLimitRetryAttempt: 0 }),
				undefined,
				undefined,
			);
			expect(enqueueDelayedRetry).toHaveBeenCalledWith(
				expect.objectContaining({ runId: 'run-1' }),
				0,
			);
		});

		it('rejects a deferred run with no pending retry and no jobPayload', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({ id: 'run-1', status: 'deferred', jobPayload: null }),
			);
			vi.mocked(resetRunToRunning).mockResolvedValue(true);
			vi.mocked(promoteRetryForRun).mockResolvedValue(false);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
			);
			expect(enqueueDelayedRetry).not.toHaveBeenCalled();
		});

		it('rejects a deferred retry when another caller already claimed the row', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ status: 'deferred' }));
			vi.mocked(resetRunToRunning).mockResolvedValue(false);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'CONFLICT' }),
			);
			expect(promoteRetryForRun).not.toHaveBeenCalled();
		});

		it('rejects a failed retry when another caller already claimed the row', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeRun({
					status: 'failed',
					jobPayload: { type: 'github', projectId: 'p1', event: {} } as never,
				}),
			);
			vi.mocked(resetRunToRunning).mockResolvedValue(false);

			await expect(caller.retryNow({ runId: 'run-1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'CONFLICT' }),
			);
			expect(enqueueDelayedRetry).not.toHaveBeenCalled();
		});

		it('clears a stale user-termination flag before re-running the row', async () => {
			// A run terminated while deferred keeps its cancellation entry; retrying
			// reuses the same run id, so the flag must be cleared or the worker would
			// instantly terminate the fresh attempt (issue #166).
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(resetRunToRunning).mockResolvedValue(true);
			vi.mocked(promoteRetryForRun).mockResolvedValue(true);

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
			expect(requestRunCancellation).toHaveBeenCalledWith('run-1');
			// The worker owns an in-flight run's terminal state — the mutation must not
			// write the row itself.
			expect(markRunUserTerminated).not.toHaveBeenCalled();
			expect(removePendingRetryForRun).not.toHaveBeenCalled();
		});

		it('cancels the pending retry and fails the row for a deferred run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ id: 'run-1', status: 'deferred' }));
			vi.mocked(removePendingRetryForRun).mockResolvedValue(1);
			vi.mocked(markRunUserTerminated).mockResolvedValue(true);

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'failed' });
			expect(requestRunCancellation).toHaveBeenCalledWith('run-1');
			expect(removePendingRetryForRun).toHaveBeenCalledWith('run-1');
			expect(markRunUserTerminated).toHaveBeenCalledWith(
				'run-1',
				USER_TERMINATION_MESSAGE,
				'deferred',
			);
			// Keep the marker until an explicit retry clears it: the worker's
			// completed handler may still be about to enqueue the delayed retry.
			expect(clearRunCancellation).not.toHaveBeenCalled();
		});

		it('falls back to the worker path when a deferred run was picked up concurrently', async () => {
			// The conditional deferred→failed loses the race (returns false): the row is
			// now running. Re-read shows running → report terminating; the flag we set
			// drives the worker to terminate it.
			vi.mocked(getRunByIdFromDb)
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'deferred' }))
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'running' }));
			vi.mocked(removePendingRetryForRun).mockResolvedValue(0);
			vi.mocked(markRunUserTerminated).mockResolvedValue(false);

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'terminating' });
			expect(requestRunCancellation).toHaveBeenCalledWith('run-1');
			expect(clearRunCancellation).not.toHaveBeenCalled();
		});

		it('returns the settled state when a deferred run settled during termination', async () => {
			// The conditional lost the race and the re-read shows the run already
			// terminal (a concurrent pickup completed it) — report that, don't error.
			vi.mocked(getRunByIdFromDb)
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'deferred' }))
				.mockResolvedValueOnce(makeRun({ id: 'run-1', status: 'completed' }));
			vi.mocked(removePendingRetryForRun).mockResolvedValue(0);
			vi.mocked(markRunUserTerminated).mockResolvedValue(false);

			const result = await caller.terminate({ runId: 'run-1' });

			expect(result).toEqual({ runId: 'run-1', status: 'completed' });
		});
	});
});
