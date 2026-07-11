import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { deleteProjectFromDb } from '../../../src/db/repositories/projectsRepository.js';
import {
	completeRun,
	createRun,
	failOrphanedRunningRuns,
	getRunByIdFromDb,
	getRunLogsFromDb,
	listRunsFromDb,
	resetRunToRunning,
	storeRunLogs,
} from '../../../src/db/repositories/runsRepository.js';
import { runLogs, runs } from '../../../src/db/schema/runs.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

// `runs.project_id` FKs `projects`, so every run needs a seeded project first.
const PROJECT_ID = 'proj-runs';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('runsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/runs-repo' });
	});

	describe('createRun', () => {
		it('inserts a running row and resolves it by id', async () => {
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '42',
				phase: 'implementation',
				workItemId: 'WI_42',
				workItemTitle: 'Fix the widget',
				workItemUrl: 'https://github.com/jkwiecien/runs-repo/issues/42',
			});

			const row = await getRunByIdFromDb(id);
			expect(row).toBeDefined();
			expect(row?.projectId).toBe(PROJECT_ID);
			expect(row?.taskId).toBe('42');
			expect(row?.phase).toBe('implementation');
			expect(row?.workItemId).toBe('WI_42');
			expect(row?.workItemTitle).toBe('Fix the widget');
			expect(row?.workItemUrl).toBe('https://github.com/jkwiecien/runs-repo/issues/42');
			expect(row?.status).toBe('running');
			// Columns only set at completion (or when a model override exists) stay null.
			expect(row?.engine).toBeNull();
			expect(row?.model).toBeNull();
			expect(row?.completedAt).toBeNull();
			expect(row?.nextRetryAt).toBeNull();
			expect(row?.startedAt).toBeInstanceOf(Date);
		});

		it('stores null work-item metadata when it is omitted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '7', phase: 'review' });

			const row = await getRunByIdFromDb(id);
			expect(row?.workItemTitle).toBeNull();
			expect(row?.workItemUrl).toBeNull();
		});

		it('returns undefined for an unknown run id', async () => {
			expect(await getRunByIdFromDb('00000000-0000-0000-0000-000000000000')).toBeUndefined();
		});
	});

	describe('completeRun', () => {
		it('flips a running row to completed and sets its outcome columns', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });

			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				timedOut: false,
				durationMs: 9876,
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('completed');
			expect(row?.engine).toBe('claude');
			expect(row?.exitCode).toBe(0);
			expect(row?.timedOut).toBe(false);
			expect(row?.durationMs).toBe(9876);
			expect(row?.completedAt).toBeInstanceOf(Date);
			expect(row?.nextRetryAt).toBeNull();
		});

		it('records a failed run with its error message', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '2', phase: 'planning' });

			await completeRun(id, { status: 'failed', engine: 'claude', exitCode: 1, error: 'boom' });

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('failed');
			expect(row?.error).toBe('boom');
			expect(row?.exitCode).toBe(1);
		});

		it('round-trips reported token usage', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '4', phase: 'implementation' });

			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				usage: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89 },
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.usage).toEqual({ inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89 });
		});

		it('leaves usage null when omitted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '5', phase: 'implementation' });

			await completeRun(id, { status: 'completed', engine: 'claude', exitCode: 0 });

			const row = await getRunByIdFromDb(id);
			expect(row?.usage).toBeNull();
		});

		it('records a deferred run without treating it as an error', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '3', phase: 'review' });
			const nextRetryAt = new Date('2026-07-10T12:30:00.000Z');

			await completeRun(id, { status: 'deferred', error: 'rate limited', nextRetryAt });

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('deferred');
			expect(row?.completedAt).toBeInstanceOf(Date);
			expect(row?.nextRetryAt).toEqual(nextRetryAt);
		});
	});

	describe('resetRunToRunning', () => {
		it('flips a deferred run back to running and clears its terminal columns', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9', phase: 'review' });
			await completeRun(id, {
				status: 'deferred',
				engine: 'claude',
				exitCode: 1,
				timedOut: true,
				error: 'rate limited',
				durationMs: 4200,
				nextRetryAt: new Date('2026-07-10T12:30:00.000Z'),
				usage: { inputTokens: 10, outputTokens: 5 },
			});

			const reset = await resetRunToRunning(id);

			expect(reset).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('running');
			expect(row?.completedAt).toBeNull();
			expect(row?.error).toBeNull();
			expect(row?.nextRetryAt).toBeNull();
			expect(row?.engine).toBeNull();
			expect(row?.exitCode).toBeNull();
			expect(row?.timedOut).toBe(false);
			expect(row?.durationMs).toBeNull();
			expect(row?.usage).toBeNull();
		});

		it('returns false when no row matches the id (pruned between defer and retry)', async () => {
			expect(await resetRunToRunning('00000000-0000-0000-0000-000000000000')).toBe(false);
		});
	});

	describe('storeRunLogs / getRunLogsFromDb', () => {
		it('persists stdout/stderr and reads them back', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });

			await storeRunLogs(id, 'the output', 'the errors');

			expect(await getRunLogsFromDb(id)).toEqual({ stdout: 'the output', stderr: 'the errors' });
		});

		it('upserts on a second store for the same run (one log row per run)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });

			await storeRunLogs(id, 'first', 'firsterr');
			await storeRunLogs(id, 'second', 'seconderr');

			expect(await getRunLogsFromDb(id)).toEqual({ stdout: 'second', stderr: 'seconderr' });
			const rows = await getDb().select().from(runLogs).where(eq(runLogs.runId, id));
			expect(rows).toHaveLength(1);
		});

		it('returns undefined for a run with no logs row', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });
			expect(await getRunLogsFromDb(id)).toBeUndefined();
		});
	});

	describe('listRunsFromDb', () => {
		// Insert rows directly with controlled startedAt so ordering/pagination is
		// deterministic (createRun stamps started_at with now()).
		async function seedRun(overrides: {
			projectId?: string;
			status?: string;
			phase?: string;
			startedAt: Date;
		}): Promise<void> {
			await getDb()
				.insert(runs)
				.values({
					projectId: overrides.projectId ?? PROJECT_ID,
					taskId: 't',
					phase: overrides.phase ?? 'review',
					status: overrides.status ?? 'running',
					startedAt: overrides.startedAt,
				});
		}

		it('filters by project, status, and phase, and counts the filtered set', async () => {
			await seedProject({ id: 'proj-other', repo: 'jkwiecien/other-repo' });
			await seedRun({ status: 'completed', phase: 'review', startedAt: new Date('2026-01-01') });
			await seedRun({ status: 'failed', phase: 'planning', startedAt: new Date('2026-01-02') });
			await seedRun({
				projectId: 'proj-other',
				status: 'completed',
				phase: 'review',
				startedAt: new Date('2026-01-03'),
			});

			const byProject = await listRunsFromDb({ projectId: PROJECT_ID, limit: 50, offset: 0 });
			expect(byProject.total).toBe(2);
			expect(byProject.data).toHaveLength(2);

			const byStatus = await listRunsFromDb({ status: 'completed', limit: 50, offset: 0 });
			expect(byStatus.total).toBe(2);

			const byPhase = await listRunsFromDb({ phase: 'planning', limit: 50, offset: 0 });
			expect(byPhase.total).toBe(1);
			expect(byPhase.data[0].phase).toBe('planning');

			const combined = await listRunsFromDb({
				projectId: PROJECT_ID,
				status: 'completed',
				limit: 50,
				offset: 0,
			});
			expect(combined.total).toBe(1);
		});

		it('orders by startedAt descending', async () => {
			await seedRun({ startedAt: new Date('2026-01-01') });
			await seedRun({ startedAt: new Date('2026-03-01') });
			await seedRun({ startedAt: new Date('2026-02-01') });

			const { data } = await listRunsFromDb({ limit: 50, offset: 0 });
			expect(data.map((r) => r.startedAt.getTime())).toEqual([
				new Date('2026-03-01').getTime(),
				new Date('2026-02-01').getTime(),
				new Date('2026-01-01').getTime(),
			]);
		});

		it('paginates with limit/offset while total reflects the full filtered count', async () => {
			for (let i = 0; i < 5; i++) {
				await seedRun({ startedAt: new Date(2026, 0, i + 1) });
			}

			const page1 = await listRunsFromDb({ limit: 2, offset: 0 });
			expect(page1.total).toBe(5);
			expect(page1.data).toHaveLength(2);
			expect(page1.data[0].startedAt.getTime()).toBe(new Date(2026, 0, 5).getTime());

			const page3 = await listRunsFromDb({ limit: 2, offset: 4 });
			expect(page3.total).toBe(5);
			expect(page3.data).toHaveLength(1);
			expect(page3.data[0].startedAt.getTime()).toBe(new Date(2026, 0, 1).getTime());
		});

		it('returns an empty page and zero total when nothing matches', async () => {
			const result = await listRunsFromDb({ projectId: 'nobody', limit: 10, offset: 0 });
			expect(result).toEqual({ data: [], total: 0 });
		});
	});

	describe('cascade delete', () => {
		it('removes a project’s runs (and their logs) when the project is deleted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });
			await storeRunLogs(id, 'out', 'err');

			await deleteProjectFromDb(PROJECT_ID);

			expect(await getRunByIdFromDb(id)).toBeUndefined();
			expect(await getRunLogsFromDb(id)).toBeUndefined();
		});

		it('removes a run’s logs when the run itself is deleted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });
			await storeRunLogs(id, 'out', 'err');

			await getDb().delete(runs).where(eq(runs.id, id));

			expect(await getRunLogsFromDb(id)).toBeUndefined();
		});
	});

	describe('failOrphanedRunningRuns', () => {
		it('flips leftover running rows to failed and leaves settled ones untouched', async () => {
			const orphanA = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });
			const orphanB = await createRun({
				projectId: PROJECT_ID,
				taskId: '2',
				phase: 'implementation',
			});
			const settled = await createRun({ projectId: PROJECT_ID, taskId: '3', phase: 'planning' });
			await completeRun(settled, { status: 'completed' });

			const count = await failOrphanedRunningRuns('interrupted by restart');

			expect(count).toBe(2);
			for (const id of [orphanA, orphanB]) {
				const row = await getRunByIdFromDb(id);
				expect(row?.status).toBe('failed');
				expect(row?.error).toBe('interrupted by restart');
				expect(row?.completedAt).toBeInstanceOf(Date);
			}
			// A run that already reached a terminal status is not rewritten.
			const settledRow = await getRunByIdFromDb(settled);
			expect(settledRow?.status).toBe('completed');
			expect(settledRow?.error).toBeNull();
		});

		it('returns 0 when there are no running rows', async () => {
			expect(await failOrphanedRunningRuns('nothing to do')).toBe(0);
		});
	});
});
