import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { createRun } from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	acquireLease,
	getLiveSession,
	heartbeat,
	releaseLease,
	setCurrentRun,
} from '../../../src/db/repositories/workerSessionsRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import { runs } from '../../../src/db/schema/runs.js';
import { workerSessions } from '../../../src/db/schema/workerSessions.js';
import { workers } from '../../../src/db/schema/workers.js';
import { WorkerSessionHeldError } from '../../../src/identity/worker-session.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const TTL = 60_000;
const PROJECT_ID = 'proj-worker-sessions';

/** Push a worker's session heartbeat far enough into the past that it is expired under `TTL`. */
async function expireSession(workerId: string): Promise<void> {
	await getDb()
		.update(workerSessions)
		.set({ lastHeartbeatAt: new Date(Date.now() - 10 * TTL) })
		.where(eq(workerSessions.workerId, workerId));
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'workerSessionsRepository (integration)',
	() => {
		let adaId: string;
		let workerA: string;
		let workerB: string;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/worker-sessions-repo' });
			adaId = (await createUser({ identifier: 'ada@example.com', displayName: 'Ada' })).id;
			workerA = (
				await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-laptop',
					capabilities: ['claude'],
					credentialHash: 'hash-a',
				})
			).id;
			workerB = (
				await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-desktop',
					capabilities: ['codex'],
					credentialHash: 'hash-b',
				})
			).id;
		});

		describe('acquireLease', () => {
			it('inserts the first session at fencing token 1', async () => {
				const session = await acquireLease(workerA, TTL);
				expect(session.workerId).toBe(workerA);
				expect(session.fencingToken).toBe(1);
				expect(session.currentRunId).toBeNull();
				expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
			});

			it('rejects a second acquire while a live session is held', async () => {
				await acquireLease(workerA, TTL);
				await expect(acquireLease(workerA, TTL)).rejects.toBeInstanceOf(WorkerSessionHeldError);
				// Still exactly one row for the worker.
				const rows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(rows).toHaveLength(1);
			});

			it('lets exactly one of two concurrent acquires win', async () => {
				const results = await Promise.allSettled([
					acquireLease(workerA, TTL),
					acquireLease(workerA, TTL),
				]);
				const fulfilled = results.filter((r) => r.status === 'fulfilled');
				const rejected = results.filter((r) => r.status === 'rejected');
				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(1);
				expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
					WorkerSessionHeldError,
				);
			});

			it('re-acquires an expired session with a bumped fencing token, reusing one row', async () => {
				const first = await acquireLease(workerA, TTL);
				expect(first.fencingToken).toBe(1);

				await expireSession(workerA);

				const second = await acquireLease(workerA, TTL);
				expect(second.fencingToken).toBe(2);
				// The expired lease was replaced in place, not duplicated.
				const rows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(rows).toHaveLength(1);
			});

			it('re-acquires after a graceful release, back at fencing token 1', async () => {
				const first = await acquireLease(workerA, TTL);
				expect(await releaseLease(workerA, first.fencingToken)).toBe(true);
				expect(await getLiveSession(workerA, TTL)).toBeUndefined();

				const second = await acquireLease(workerA, TTL);
				// Released row is gone, so the fresh insert starts over at 1.
				expect(second.fencingToken).toBe(1);
			});

			it('gives two different workers of one user independent live sessions', async () => {
				const a = await acquireLease(workerA, TTL);
				const b = await acquireLease(workerB, TTL);
				expect(a.fencingToken).toBe(1);
				expect(b.fencingToken).toBe(1);
				expect(await getLiveSession(workerA, TTL)).toMatchObject({ workerId: workerA });
				expect(await getLiveSession(workerB, TTL)).toMatchObject({ workerId: workerB });
			});
		});

		describe('heartbeat', () => {
			it('refreshes a live session with the matching token', async () => {
				const session = await acquireLease(workerA, TTL);
				expect(await heartbeat(workerA, session.fencingToken, TTL)).toBe(true);
			});

			it('rejects a heartbeat with the old token after the lease was replaced (stale fencing)', async () => {
				const first = await acquireLease(workerA, TTL);
				await expireSession(workerA);
				const second = await acquireLease(workerA, TTL);
				expect(second.fencingToken).toBe(2);

				// The replaced daemon still holds token 1 — its heartbeat must be rejected...
				expect(await heartbeat(workerA, first.fencingToken, TTL)).toBe(false);
				// ...while the new holder's token still works.
				expect(await heartbeat(workerA, second.fencingToken, TTL)).toBe(true);
			});

			it('rejects a heartbeat once the lease has expired', async () => {
				const session = await acquireLease(workerA, TTL);
				await expireSession(workerA);
				expect(await heartbeat(workerA, session.fencingToken, TTL)).toBe(false);
			});
		});

		describe('releaseLease', () => {
			it('does not release with a non-matching token', async () => {
				const session = await acquireLease(workerA, TTL);
				expect(await releaseLease(workerA, session.fencingToken + 99)).toBe(false);
				expect(await getLiveSession(workerA, TTL)).toMatchObject({ workerId: workerA });
			});
		});

		describe('setCurrentRun', () => {
			it('attaches and clears a run on a live, current-token session', async () => {
				const session = await acquireLease(workerA, TTL);
				const runId = await createRun({
					projectId: PROJECT_ID,
					taskId: 'w-1',
					phase: 'implementation',
				});

				expect(await setCurrentRun(workerA, session.fencingToken, runId, TTL)).toBe(true);
				expect((await getLiveSession(workerA, TTL))?.currentRunId).toBe(runId);

				expect(await setCurrentRun(workerA, session.fencingToken, null, TTL)).toBe(true);
				expect((await getLiveSession(workerA, TTL))?.currentRunId).toBeNull();
			});

			it('rejects a run-attach with a stale token', async () => {
				const session = await acquireLease(workerA, TTL);
				const runId = await createRun({
					projectId: PROJECT_ID,
					taskId: 'w-2',
					phase: 'implementation',
				});
				expect(await setCurrentRun(workerA, session.fencingToken + 1, runId, TTL)).toBe(false);
			});

			it('nulls current_run_id when the referenced run is deleted (ON DELETE SET NULL)', async () => {
				const session = await acquireLease(workerA, TTL);
				const runId = await createRun({
					projectId: PROJECT_ID,
					taskId: 'w-3',
					phase: 'implementation',
				});
				await setCurrentRun(workerA, session.fencingToken, runId, TTL);

				await getDb().delete(runs).where(eq(runs.id, runId));

				// The session survives; only its run pointer is cleared.
				expect((await getLiveSession(workerA, TTL))?.currentRunId).toBeNull();
			});
		});

		describe('cascade delete', () => {
			it('drops a session when its worker is deleted', async () => {
				await acquireLease(workerA, TTL);
				await getDb().delete(workers).where(eq(workers.id, workerA));

				const rows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(rows).toHaveLength(0);
			});
		});
	},
);
