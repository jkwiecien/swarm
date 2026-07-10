import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	listRunsFromDb: vi.fn(),
	getRunByIdFromDb: vi.fn(),
	getRunLogsFromDb: vi.fn(),
}));

import { runsRouter } from '@/api/routers/runs.js';
import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	listRunsFromDb,
} from '@/db/repositories/runsRepository.js';
import type { runs } from '@/db/schema/runs.js';

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
		...overrides,
	};
}

describe('runsRouter', () => {
	const caller = runsRouter.createCaller({});

	beforeEach(() => {
		vi.mocked(listRunsFromDb).mockReset();
		vi.mocked(getRunByIdFromDb).mockReset();
		vi.mocked(getRunLogsFromDb).mockReset();
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
});
