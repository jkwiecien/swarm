/**
 * Worker-session persistence — plain functions, one `getDb()` per call, no class,
 * mirroring `workersRepository.ts` / `projectMembershipRequestsRepository.ts`.
 * Backs the `worker_sessions` table (`src/db/schema/workerSessions.ts`), the
 * persisted form of `WorkerSession` (`src/identity/worker-session.ts`, the source
 * of truth for the shape). Phase 2 of the worker slice.
 *
 * `acquireLease` is the crux: an atomic conditional transition in one
 * transaction (the same style as `approveMembershipRequestInDb`). It reads the
 * worker's row `FOR UPDATE`, then either rejects (a *live* lease is held),
 * replaces the row with a bumped fencing token (an *expired* lease is re-taken),
 * or inserts the first session — and the row lock plus the table's unique index
 * on `worker_id` together guarantee exactly one concurrent caller wins. A racing
 * insert that trips the unique index (`23505`) is surfaced as the same
 * `WorkerSessionHeldError` as an already-live lease, so contention has one type.
 *
 * `heartbeat`, `setCurrentRun`, and `getLiveSession` all gate on the same SQL
 * liveness predicate as `isSessionLive` (`last_heartbeat_at` strictly newer than
 * `now − ttl`) *and* — for the write paths — a matching fencing token, so a
 * heartbeat or run-attach from a replaced (stale-token) or expired holder is
 * rejected. Lookups that match nothing return `undefined`/`false` — a not-found,
 * not an error (ai/CODING_STANDARDS.md "Error handling").
 */

import { and, eq, gt } from 'drizzle-orm';

import {
	INITIAL_FENCING_TOKEN,
	isSessionLive,
	nextFencingToken,
	type WorkerSession,
	WorkerSessionHeldError,
} from '../../identity/worker-session.js';
import { getDb } from '../client.js';
import { workerSessions } from '../schema/workerSessions.js';

type WorkerSessionRow = typeof workerSessions.$inferSelect;

/** Re-assemble a `WorkerSession` from a persisted `worker_sessions` row. */
function rowToSession(row: WorkerSessionRow): WorkerSession {
	return {
		id: row.id,
		workerId: row.workerId,
		fencingToken: row.fencingToken,
		lastHeartbeatAt: row.lastHeartbeatAt,
		currentRunId: row.currentRunId,
		createdAt: row.createdAt,
	};
}

/** True for a pg `23505` unique-violation, whether the code is on the error or its `cause`. */
function isUniqueViolation(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	if ((err as { code?: string }).code === '23505') return true;
	const cause = (err as { cause?: unknown }).cause;
	return (
		typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505'
	);
}

/** The `now − ttl` cutoff a row's `last_heartbeat_at` must be newer than to count as live. */
function livenessCutoff(ttlMs: number): Date {
	return new Date(Date.now() - ttlMs);
}

/**
 * Acquire the single lease for a worker, atomically. In one transaction, lock
 * the worker's existing session row `FOR UPDATE` (if any) and:
 *
 * - **live** (unreleased and last heartbeat within `ttlMs`) → throw {@link WorkerSessionHeldError};
 * - **expired / released** → replace it in place with a bumped fencing token, a fresh
 *   heartbeat, `released: false`, and no current run (a new lease on the same row);
 * - **none** → insert the first session at {@link INITIAL_FENCING_TOKEN}.
 *
 * The row lock serializes concurrent acquires against an existing row, and the
 * table's unique index on `worker_id` serializes a racing first insert — the
 * loser's `23505` is translated to the same `WorkerSessionHeldError`, so exactly
 * one concurrent caller ever wins.
 */
export async function acquireLease(workerId: string, ttlMs: number): Promise<WorkerSession> {
	try {
		return await getDb().transaction(async (tx) => {
			const now = new Date();
			const [existing] = await tx
				.select()
				.from(workerSessions)
				.where(eq(workerSessions.workerId, workerId))
				.for('update')
				.limit(1);

			if (existing) {
				if (!existing.released && isSessionLive(existing.lastHeartbeatAt, ttlMs, now)) {
					throw new WorkerSessionHeldError(workerId);
				}
				const [replaced] = await tx
					.update(workerSessions)
					.set({
						fencingToken: nextFencingToken(existing.fencingToken),
						lastHeartbeatAt: now,
						currentRunId: null,
						released: false,
					})
					.where(eq(workerSessions.id, existing.id))
					.returning();
				return rowToSession(replaced);
			}

			const [inserted] = await tx
				.insert(workerSessions)
				.values({ workerId, fencingToken: INITIAL_FENCING_TOKEN, lastHeartbeatAt: now })
				.returning();
			return rowToSession(inserted);
		});
	} catch (err) {
		if (isUniqueViolation(err)) throw new WorkerSessionHeldError(workerId);
		throw err;
	}
}

/**
 * Record a heartbeat: refresh `last_heartbeat_at` to now, but only for an active
 * session that still matches `fencingToken` *and* is not already expired under `ttlMs`.
 * Returns `true` if a live, current-token session was refreshed, `false`
 * otherwise — so a heartbeat from a replaced or released (stale-token) holder, or one
 * that arrives after the lease already lapsed, is rejected rather than reviving it.
 */
export async function heartbeat(
	workerId: string,
	fencingToken: number,
	ttlMs: number,
): Promise<boolean> {
	const [updated] = await getDb()
		.update(workerSessions)
		.set({ lastHeartbeatAt: new Date() })
		.where(
			and(
				eq(workerSessions.workerId, workerId),
				eq(workerSessions.fencingToken, fencingToken),
				eq(workerSessions.released, false),
				gt(workerSessions.lastHeartbeatAt, livenessCutoff(ttlMs)),
			),
		)
		.returning({ id: workerSessions.id });
	return Boolean(updated);
}

/**
 * Gracefully release the lease: mark the session row as released and clear its run,
 * retaining the row so its per-worker fencing counter stays monotonic across
 * re-acquisition. Only releases when `fencingToken` matches and the session is active.
 * Returns `true` if updated, `false` if none matched.
 */
export async function releaseLease(workerId: string, fencingToken: number): Promise<boolean> {
	const rows = await getDb()
		.update(workerSessions)
		.set({ released: true, currentRunId: null })
		.where(
			and(
				eq(workerSessions.workerId, workerId),
				eq(workerSessions.fencingToken, fencingToken),
				eq(workerSessions.released, false),
			),
		)
		.returning({ id: workerSessions.id });
	return rows.length > 0;
}

/**
 * Set (or clear, with `null`) the run a live session is executing, gated on a
 * matching fencing token, active status, and non-expired lease — the same guard as `heartbeat`.
 * Returns `true` if a live, current-token session was updated, `false` otherwise.
 */
export async function setCurrentRun(
	workerId: string,
	fencingToken: number,
	runId: string | null,
	ttlMs: number,
): Promise<boolean> {
	const [updated] = await getDb()
		.update(workerSessions)
		.set({ currentRunId: runId })
		.where(
			and(
				eq(workerSessions.workerId, workerId),
				eq(workerSessions.fencingToken, fencingToken),
				eq(workerSessions.released, false),
				gt(workerSessions.lastHeartbeatAt, livenessCutoff(ttlMs)),
			),
		)
		.returning({ id: workerSessions.id });
	return Boolean(updated);
}

/**
 * The worker's retained session row whatever its state — live, expired, or
 * gracefully released. Deliberately *not* liveness-gated: it exists so a caller
 * can read `lastHeartbeatAt` as **last seen** for a worker that is currently
 * offline (the row survives expiry and release to keep the fencing counter
 * monotonic). {@link getLiveSession} stays the only liveness check; never derive
 * online/offline from this read. `undefined` when the worker never connected.
 */
export async function getRetainedSession(workerId: string): Promise<WorkerSession | undefined> {
	const rows = await getDb()
		.select()
		.from(workerSessions)
		.where(eq(workerSessions.workerId, workerId))
		.limit(1);
	const row = rows[0];
	return row ? rowToSession(row) : undefined;
}

/**
 * The worker's live session (unreleased and last heartbeat within `ttlMs`), or
 * `undefined` if it has none, is released, or its lease has expired. The read the
 * fencing-token validation seam and dashboard build on.
 */
export async function getLiveSession(
	workerId: string,
	ttlMs: number,
): Promise<WorkerSession | undefined> {
	const rows = await getDb()
		.select()
		.from(workerSessions)
		.where(
			and(
				eq(workerSessions.workerId, workerId),
				eq(workerSessions.released, false),
				gt(workerSessions.lastHeartbeatAt, livenessCutoff(ttlMs)),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToSession(row) : undefined;
}
