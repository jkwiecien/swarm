import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	listRunsFromDb: vi.fn(),
	getRunByIdFromDb: vi.fn(),
	getRunLogsFromDb: vi.fn(),
	resetRunToRunning: vi.fn(),
}));

vi.mock('@/queue/producer.js', () => ({
	promoteRetryForRun: vi.fn(),
	enqueueDelayedRetry: vi.fn(),
}));

import { runsRouter } from '@/api/routers/runs.js';
import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	listRunsFromDb,
	resetRunToRunning,
} from '@/db/repositories/runsRepository.js';
import type { runs } from '@/db/schema/runs.js';
import { enqueueDelayedRetry, promoteRetryForRun } from '@/queue/producer.js';

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
			expect(resetRunToRunning).toHaveBeenCalledWith('run-1', undefined, 'deferred');
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
	});
});
