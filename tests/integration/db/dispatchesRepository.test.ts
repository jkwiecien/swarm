import { beforeEach, describe, expect, it } from 'vitest';

import {
	cancelAllWaitingDispatches,
	cancelWaitingDispatch,
	claimDispatch,
	completeDispatch,
	createDispatch,
	deferDispatchToPending,
	failDispatch,
	failExpiredDispatchLeases,
	getActiveDispatchByRunId,
	getDispatchById,
	listDeferredRunsWithoutActiveDispatch,
	listWaitingDispatches,
	listWakeablePendingDispatches,
	markDispatchRunning,
	reopenDispatchForManualRetry,
	scheduleDispatchRetry,
	selectNextCapacityDispatch,
	supersedeDispatchesByCoalesceKey,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	completeRun,
	createRun,
	listRunsFromDb,
} from '../../../src/db/repositories/runsRepository.js';
import { describeError } from '../../../src/lib/errors.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { createMockGitHubWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-dispatches';
const OWNER = 'test-worker:1';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockGitHubWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('dispatchesRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/dispatch-repo' });
	});

	describe('create + dedup identity', () => {
		it('deduplicates on dedupKey, returning the existing row for a redelivery', async () => {
			const first = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-1' }),
				dedupKey: 'delivery:d-1',
				source: 'webhook',
			});
			const second = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-1' }),
				dedupKey: 'delivery:d-1',
				source: 'webhook',
			});

			expect(first.created).toBe(true);
			expect(second.created).toBe(false);
			expect(second.dispatch.id).toBe(first.dispatch.id);
		});

		it('enforces at most one active dispatch per run row (the duplicate-retry guard)', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: '17', phase: 'review' });
			await completeRun(runId, { status: 'failed', error: 'boom' });

			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			});

			// Drizzle wraps the pg error; the constraint name lives in the cause
			// chain (`describeError` is what the API's CONFLICT detection reads).
			const failure = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			}).then(
				() => null,
				(err: unknown) => describeError(err),
			);
			expect(failure).toMatch(/uq_dispatches_active_run|duplicate key/);
		});

		it('allows a new active dispatch for a run whose prior dispatch is terminal', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: '17', phase: 'review' });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);
			await failDispatch(dispatch.id, 'first attempt failed');

			const second = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			});
			expect(second.created).toBe(true);
		});
	});

	describe('claim (dequeue → claim boundary)', () => {
		it('claims a pending dispatch exactly once — the loser is refused', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});

			const [a, b] = await Promise.all([
				claimDispatch(dispatch.id, 'worker-a:1', 60_000),
				claimDispatch(dispatch.id, 'worker-b:1', 60_000),
			]);

			// Exactly one concurrent claimant wins.
			expect([a, b].filter((r) => r !== null)).toHaveLength(1);
		});

		it('lets the same owner re-claim its own lease (a delivery retry after an infra throw)', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).not.toBeNull();
			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).not.toBeNull();
			expect(await claimDispatch(dispatch.id, 'other-worker:2', 60_000)).toBeNull();
		});

		it('refuses to claim a cancelled dispatch — cancellation prevents resurrection', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			expect(await cancelWaitingDispatch(dispatch.id, 'operator cleared the queue')).not.toBeNull();

			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).toBeNull();
			const row = await getDispatchById(dispatch.id);
			expect(row?.state).toBe('cancelled');
		});

		it('refuses to claim completed and failed dispatches', async () => {
			for (const settle of [completeDispatch, failDispatch] as const) {
				const { dispatch } = await createDispatch({
					projectId: PROJECT_ID,
					jobPayload: job(),
					source: 'webhook',
				});
				await claimDispatch(dispatch.id, OWNER, 60_000);
				await (settle === completeDispatch
					? completeDispatch(dispatch.id, 'phase-succeeded')
					: failDispatch(dispatch.id, 'boom'));
				expect(await claimDispatch(dispatch.id, OWNER, 60_000)).toBeNull();
			}
		});
	});

	describe('defer → reschedule boundary', () => {
		it('persists the derived retry payload durably and bumps the wake sequence', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);

			const retryAt = new Date(Date.now() + 60_000);
			const updated = await scheduleDispatchRetry(dispatch.id, {
				jobPayload: job({ rateLimitRetryAttempt: 1, resumeSession: true }),
				availableAt: retryAt,
				waitReason: 'rate-limit',
				attempt: 1,
			});

			expect(updated).toMatchObject({
				state: 'retry-scheduled',
				waitReason: 'rate-limit',
				attempt: 1,
				wakeSeq: 1,
				leaseOwner: null,
			});
			expect(updated?.jobPayload).toMatchObject({ rateLimitRetryAttempt: 1, resumeSession: true });
			// A crash here loses only the wake-up, never the intent: the row is
			// what the reconciler re-publishes from.
			expect(await listWakeablePendingDispatches()).toHaveLength(1);
		});

		it('lets a cancellation win over a concurrent defer (cancel → remove boundary)', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);
			// A running dispatch is not waiting — a queue-clear style cancel misses it…
			expect(await cancelWaitingDispatch(dispatch.id, 'cleared')).toBeNull();
			// …but once deferred it is cancellable, and the cancel then blocks the wake-up.
			await scheduleDispatchRetry(dispatch.id, {
				jobPayload: job(),
				availableAt: new Date(),
				waitReason: 'rate-limit',
				attempt: 1,
			});
			expect(await cancelWaitingDispatch(dispatch.id, 'cleared')).not.toBeNull();
			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).toBeNull();
		});
	});

	describe('capacity waits and promotion', () => {
		it('returns a claimed dispatch to pending with the capacity wait reason', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);

			const pending = await deferDispatchToPending(dispatch.id, {
				jobPayload: job({ continuationDispatchClaimed: true }),
				waitReason: 'project-capacity',
				continuation: true,
			});

			expect(pending).toMatchObject({
				state: 'pending',
				waitReason: 'project-capacity',
				continuation: true,
				wakeSeq: 1,
			});
			// Capacity waits are woken by slot releases, not timers — the wake-up
			// republisher must not touch them.
			expect(await listWakeablePendingDispatches()).toHaveLength(0);
		});

		it('selects the oldest continuation first when the policy is on, FIFO otherwise', async () => {
			async function capacityPending(continuation: boolean, availableAt: Date): Promise<string> {
				const { dispatch } = await createDispatch({
					projectId: PROJECT_ID,
					jobPayload: job(),
					source: 'webhook',
					state: 'pending',
					waitReason: 'project-capacity',
					continuation,
					availableAt,
				});
				return dispatch.id;
			}
			const boardOld = await capacityPending(false, new Date(Date.now() - 60_000));
			const continuationNew = await capacityPending(true, new Date(Date.now() - 30_000));

			expect((await selectNextCapacityDispatch(PROJECT_ID, true))?.id).toBe(continuationNew);
			expect((await selectNextCapacityDispatch(PROJECT_ID, false))?.id).toBe(boardOld);
		});
	});

	describe('manual retry', () => {
		it('reopens a scheduled retry immediately with a reset attempt budget', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);
			await scheduleDispatchRetry(dispatch.id, {
				jobPayload: job({ rateLimitRetryAttempt: 6 }),
				availableAt: new Date(Date.now() + 60 * 60 * 1000),
				waitReason: 'rate-limit',
				attempt: 6,
			});

			const reopened = await reopenDispatchForManualRetry(
				dispatch.id,
				job({ rateLimitRetryAttempt: 0, cliOverride: 'codex' }),
			);

			expect(reopened).toMatchObject({
				state: 'pending',
				waitReason: 'manual-retry',
				attempt: 0,
				wakeSeq: 2,
			});
			expect(reopened?.jobPayload).toMatchObject({ cliOverride: 'codex' });
		});

		it('refuses to reopen a dispatch a worker already claimed', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);

			expect(await reopenDispatchForManualRetry(dispatch.id, job())).toBeNull();
		});
	});

	describe('lease reclaim (claim → run boundary)', () => {
		it('fails only expired leases when a cutoff is supplied, and all claims at startup', async () => {
			const expired = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(expired.dispatch.id, OWNER, -1_000); // already expired
			const live = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-live' }),
				dedupKey: 'delivery:d-live',
				source: 'webhook',
			});
			await claimDispatch(live.dispatch.id, OWNER, 60_000);

			const reclaimed = await failExpiredDispatchLeases('dead worker', new Date());
			expect(reclaimed.map((d) => d.id)).toEqual([expired.dispatch.id]);
			expect((await getDispatchById(live.dispatch.id))?.state).toBe('leased');

			const startup = await failExpiredDispatchLeases('worker restarted');
			expect(startup.map((d) => d.id)).toEqual([live.dispatch.id]);
		});

		it('covers running dispatches too — a dead run row cannot hide behind `running`', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: '17', phase: 'review' });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'webhook',
				runId,
			});
			await claimDispatch(dispatch.id, OWNER, -1_000);
			await markDispatchRunning(dispatch.id, runId, new Date(Date.now() - 1_000), '17', 'review');

			const reclaimed = await failExpiredDispatchLeases('dead worker', new Date());
			expect(reclaimed.map((d) => d.id)).toEqual([dispatch.id]);
		});
	});

	describe('coalesced supersede', () => {
		it('supersedes waiting dispatches sharing the coalesce key', async () => {
			const first = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				coalesceKey: 'check-suite:r:1:sha',
				source: 'recheck',
			});

			const superseded = await supersedeDispatchesByCoalesceKey('check-suite:r:1:sha');

			expect(superseded.map((d) => d.id)).toEqual([first.dispatch.id]);
			expect((await getDispatchById(first.dispatch.id))?.outcome).toBe('superseded');
			expect(await claimDispatch(first.dispatch.id, OWNER, 60_000)).toBeNull();
		});
	});

	describe('canonical queue read + clear', () => {
		it('reopens a concurrently visible deferred run with overrides without duplicating its dispatch', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'manual-retry',
				phase: 'resolve-conflicts',
			});
			await completeRun(runId, { status: 'deferred', error: 'rate limited' });
			const originalJob = job({ runId });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: originalJob,
				source: 'synthetic',
				state: 'retry-scheduled',
				waitReason: 'rate-limit',
				runId,
			});
			expect(
				(await listRunsFromDb({ projectId: PROJECT_ID, limit: 50, offset: 0 })).data.map(
					(run) => run.id,
				),
			).toContain(runId);

			const overriddenJob = {
				...originalJob,
				cliOverride: 'codex' as const,
				modelOverride: 'gpt-5.2-codex',
				reasoningOverride: 'high' as const,
			};
			const reopened = await reopenDispatchForManualRetry(dispatch.id, overriddenJob);

			expect(reopened).toMatchObject({
				id: dispatch.id,
				state: 'pending',
				waitReason: 'manual-retry',
				attempt: 0,
				jobPayload: expect.objectContaining({
					cliOverride: 'codex',
					modelOverride: 'gpt-5.2-codex',
					reasoningOverride: 'high',
				}),
			});
			const activeForRun = (await listWaitingDispatches(PROJECT_ID)).filter(
				(candidate) => candidate.runId === runId,
			);
			expect(activeForRun).toHaveLength(1);
			expect(activeForRun[0].id).toBe(dispatch.id);
			expect((await getActiveDispatchByRunId(runId))?.id).toBe(dispatch.id);
		});

		it('lists every waiting dispatch and cancels them all atomically', async () => {
			await createDispatch({ projectId: PROJECT_ID, jobPayload: job(), source: 'webhook' });
			const capacity = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-cap' }),
				dedupKey: 'delivery:d-cap',
				source: 'webhook',
				state: 'pending',
				waitReason: 'project-capacity',
			});
			const scheduled = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-sched' }),
				dedupKey: 'delivery:d-sched',
				source: 'recovered',
				state: 'retry-scheduled',
				waitReason: 'recovered',
				availableAt: new Date(Date.now() + 60_000),
			});

			// Nothing waiting is invisible (issue #284's acceptance criterion).
			const waiting = await listWaitingDispatches(PROJECT_ID);
			expect(waiting).toHaveLength(3);

			const cancelled = await cancelAllWaitingDispatches('queue cleared');
			expect(cancelled).toHaveLength(3);
			for (const d of [capacity.dispatch, scheduled.dispatch]) {
				expect(await claimDispatch(d.id, OWNER, 60_000)).toBeNull();
			}
			expect(await listWaitingDispatches(PROJECT_ID)).toHaveLength(0);
		});
	});

	describe('orphaned deferred-run backfill source', () => {
		it('finds deferred runs with no active dispatch and ignores covered ones', async () => {
			const orphanId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'orphan',
				phase: 'review',
			});
			await completeRun(orphanId, { status: 'deferred', error: 'rate limited' });

			const coveredId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'covered',
				phase: 'review',
			});
			await completeRun(coveredId, { status: 'deferred', error: 'rate limited' });
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId: coveredId }),
				source: 'recovered',
				state: 'retry-scheduled',
				waitReason: 'recovered',
				runId: coveredId,
			});

			const orphans = await listDeferredRunsWithoutActiveDispatch();
			expect(orphans.map((r) => r.id)).toEqual([orphanId]);
			expect(await getActiveDispatchByRunId(coveredId)).toBeDefined();
		});
	});
});
