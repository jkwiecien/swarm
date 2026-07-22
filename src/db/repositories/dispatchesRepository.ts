/**
 * Durable dispatch persistence (issue #284, ADR-002) — the state machine behind
 * every attempt to start or resume a pipeline phase. Mirrors the plain-function
 * shape of the other repositories (one `getDb()` per call, no class).
 *
 * Every lifecycle transition here is a *conditional* UPDATE (`WHERE state IN
 * (…) RETURNING`): the row's current state is the only arbiter, so two racing
 * actors — a wake-up job and a manual retry, a cancel and a slot release —
 * resolve to exactly one winner, and terminal states (`cancelled`, `completed`,
 * `failed`) can never be resurrected by a late wake-up. Orchestration (what to
 * enqueue, when to wake) lives in `src/dispatch/`; this module owns only the
 * durable record.
 */

import { and, asc, desc, eq, inArray, lte, ne, notInArray, sql } from 'drizzle-orm';
import type { SwarmJob } from '../../queue/jobs.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { getDb } from '../client.js';
import { dispatches } from '../schema/dispatches.js';
import { runs } from '../schema/runs.js';

export type DispatchRow = typeof dispatches.$inferSelect;

/** Every lifecycle state a dispatch can hold. */
export type DispatchState =
	| 'pending'
	| 'leased'
	| 'running'
	| 'retry-scheduled'
	| 'cancelled'
	| 'completed'
	| 'failed';

/** Non-terminal states — exactly the set the partial unique run index covers. */
export const ACTIVE_DISPATCH_STATES = [
	'pending',
	'leased',
	'running',
	'retry-scheduled',
] as const satisfies readonly DispatchState[];

/** States awaiting a wake-up — what the Queue API/UI shows. */
export const WAITING_DISPATCH_STATES = ['pending', 'retry-scheduled'] as const;

/** Why a non-terminal dispatch is waiting rather than running. */
export type DispatchWaitReason =
	| 'project-capacity'
	| 'rate-limit'
	| 'agent-capacity'
	| 'timeout'
	| 'worker-shutdown'
	| 'delivery'
	| 'worktree-exists'
	| 'stalled'
	| 'recheck'
	| 'manual-retry'
	| 'recovered';

/**
 * What a dispatch runs: a pipeline phase, or the agent-less merge-automation
 * executor (issue #292) — the one dispatch kind that never provisions a
 * worktree or spawns an agent CLI.
 */
export type DispatchPhase = TriggerPhase | 'merge-automation';

/**
 * Terminal detail for a `completed` dispatch. The `merge-*` values (and
 * `merged`) settle merge-automation dispatches (issue #292): every functional
 * refusal the provider reports is a normal, visible completion — only an
 * unexpected provider failure marks the dispatch `failed`.
 *
 * `skipped-not-eligible` is the one eligibility outcome: the dispatch resolved a
 * phase, but the work item is not opted into automation (it lacks the project's
 * `pipeline.automationLabel` — issue #131). The worker-authorization gate will
 * settle through the same value with its own reason (issue #339).
 */
export type DispatchOutcome =
	| 'phase-succeeded'
	| 'no-trigger'
	| 'skipped-duplicate'
	| 'skipped-not-eligible'
	| 'superseded'
	| 'merged'
	| 'merge-not-eligible'
	| 'merge-policy-blocked'
	| 'merge-unsupported'
	| 'merge-retry-exhausted';

export interface CreateDispatchInput {
	projectId: string;
	jobPayload: SwarmJob;
	/** Stable idempotency identity; a conflict returns the existing row instead of inserting. */
	dedupKey?: string;
	coalesceKey?: string;
	priority?: number;
	source: 'webhook' | 'synthetic' | 'recheck' | 'manual' | 'recovered' | 'adopted';
	waitReason?: DispatchWaitReason;
	availableAt?: Date;
	continuation?: boolean;
	runId?: string;
	taskId?: string;
	phase?: DispatchPhase;
	attempt?: number;
	/**
	 * `leased` is used only when adopting a legacy in-flight job at dequeue;
	 * `retry-scheduled` only by the startup backfill of orphaned deferred runs.
	 */
	state?: Extract<DispatchState, 'pending' | 'leased' | 'retry-scheduled'>;
	leaseOwner?: string;
	leaseExpiresAt?: Date;
}

/**
 * Insert a dispatch, deduplicating on `dedupKey`: a conflict leaves the
 * existing row untouched and returns it with `created: false`, so a redelivered
 * webhook or a crash-retried synthetic enqueue can never mint a second
 * dispatch. A `runId` conflict (the partial unique active-run index) throws —
 * callers treat that as "a retry for this run is already in flight".
 */
export async function createDispatch(
	input: CreateDispatchInput,
): Promise<{ dispatch: DispatchRow; created: boolean }> {
	const db = getDb();
	const inserted = await db
		.insert(dispatches)
		.values({
			projectId: input.projectId,
			jobPayload: input.jobPayload,
			dedupKey: input.dedupKey,
			coalesceKey: input.coalesceKey,
			priority: input.priority ?? 0,
			source: input.source,
			waitReason: input.waitReason,
			availableAt: input.availableAt ?? new Date(),
			continuation: input.continuation ?? false,
			runId: input.runId,
			taskId: input.taskId,
			phase: input.phase,
			attempt: input.attempt ?? 0,
			state: input.state ?? 'pending',
			leaseOwner: input.leaseOwner,
			leaseExpiresAt: input.leaseExpiresAt,
		})
		.onConflictDoNothing({ target: dispatches.dedupKey })
		.returning();
	if (inserted[0]) return { dispatch: inserted[0], created: true };
	// Dedup conflict — dedupKey is necessarily set (nothing else conflicts on
	// this path) and the prior row for it exists.
	const existing = await db
		.select()
		.from(dispatches)
		.where(eq(dispatches.dedupKey, input.dedupKey ?? ''))
		.limit(1);
	if (!existing[0]) throw new Error('Dispatch dedup conflict but no existing row found');
	return { dispatch: existing[0], created: false };
}

/**
 * Atomically claim a dispatch for execution: `pending`/`retry-scheduled` →
 * `leased`. Re-claiming a lease this owner already holds succeeds (a BullMQ
 * infra retry of the same job must not dead-end its own dispatch). Returns the
 * claimed row, or `null` when the dispatch is terminal, already running, or
 * held by another owner — the caller skips the wake-up as superseded.
 */
export async function claimDispatch(
	id: string,
	owner: string,
	leaseMs: number,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'leased',
			leaseOwner: owner,
			leaseExpiresAt: new Date(now.getTime() + leaseMs),
			waitReason: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(dispatches.id, id),
				sql`(${dispatches.state} IN ('pending', 'retry-scheduled') OR (${dispatches.state} = 'leased' AND ${dispatches.leaseOwner} = ${owner}))`,
			),
		)
		.returning();
	return rows[0] ?? null;
}

/**
 * Mark a claimed dispatch `running` against its run row, renewing the lease to
 * cover the phase's effective wall-clock timeout (plus the caller's margin) so
 * a live run is never reclaimed mid-flight.
 */
export async function markDispatchRunning(
	id: string,
	runId: string | undefined,
	leaseUntil: Date,
	taskId: string,
	phase: TriggerPhase,
): Promise<boolean> {
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'running',
			runId,
			taskId,
			phase,
			leaseExpiresAt: leaseUntil,
			updatedAt: new Date(),
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

/** Record the resolved task/phase on a claimed dispatch (before a run row exists). */
export async function recordDispatchResolution(
	id: string,
	taskId: string,
	phase: TriggerPhase,
): Promise<void> {
	await getDb()
		.update(dispatches)
		.set({ taskId, phase, updatedAt: new Date() })
		.where(eq(dispatches.id, id));
}

/** Settle a leased/running dispatch as `completed` with a terminal outcome. */
export async function completeDispatch(id: string, outcome: DispatchOutcome): Promise<boolean> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'completed',
			outcome,
			waitReason: null,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

/** Settle a leased/running dispatch as terminally `failed`. */
export async function failDispatch(id: string, error: string): Promise<boolean> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'failed',
			lastError: error,
			waitReason: null,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

/**
 * Cancel a waiting (`pending`/`retry-scheduled`) dispatch — the canonical
 * "never run this" operation behind terminate/put-back/queue-clear. Returns the
 * cancelled row (for best-effort wake-up removal), or `null` when the dispatch
 * was not in a cancellable state (already claimed, or already terminal).
 */
export async function cancelWaitingDispatch(
	id: string,
	reason: string,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'cancelled',
			lastError: reason,
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, [...WAITING_DISPATCH_STATES])))
		.returning();
	return rows[0] ?? null;
}

/** Settle a leased/running dispatch as `cancelled` (user terminated the run). */
export async function cancelClaimedDispatch(id: string, reason: string): Promise<boolean> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'cancelled',
			lastError: reason,
			waitReason: null,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

export interface ScheduleDispatchRetryInput {
	jobPayload: SwarmJob;
	availableAt: Date;
	waitReason: DispatchWaitReason;
	attempt: number;
	runId?: string;
}

/**
 * Defer a claimed dispatch to a scheduled retry: `leased`/`running` →
 * `retry-scheduled`, persisting the *derived* next-attempt payload (session
 * resume, PM dispatch intent, attempt counter) before any queue work happens.
 * Bumps `wakeSeq` so the retry's wake-up job id is fresh. Returns the updated
 * row (the publisher needs id + wakeSeq + availableAt), or `null` when the
 * dispatch was not claimed (e.g. a user cancellation settled it first).
 */
export async function scheduleDispatchRetry(
	id: string,
	input: ScheduleDispatchRetryInput,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'retry-scheduled',
			jobPayload: input.jobPayload,
			availableAt: input.availableAt,
			waitReason: input.waitReason,
			attempt: input.attempt,
			wakeSeq: sql`${dispatches.wakeSeq} + 1`,
			leaseOwner: null,
			leaseExpiresAt: null,
			...(input.runId !== undefined ? { runId: input.runId } : {}),
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning();
	return rows[0] ?? null;
}

export interface DeferDispatchToPendingInput {
	jobPayload: SwarmJob;
	waitReason: DispatchWaitReason;
	continuation?: boolean;
	runId?: string;
}

/**
 * Return a claimed dispatch to `pending` — the project-capacity wait: eligible
 * immediately, woken by a freed slot (or the reconciler), not by a timer.
 */
export async function deferDispatchToPending(
	id: string,
	input: DeferDispatchToPendingInput,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'pending',
			jobPayload: input.jobPayload,
			availableAt: now,
			waitReason: input.waitReason,
			wakeSeq: sql`${dispatches.wakeSeq} + 1`,
			leaseOwner: null,
			leaseExpiresAt: null,
			...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
			...(input.runId !== undefined ? { runId: input.runId } : {}),
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning();
	return rows[0] ?? null;
}

/**
 * Re-open a waiting dispatch for an immediate manual retry: reset the attempt
 * budget, apply the operator's overrides (already folded into `jobPayload`),
 * and make it eligible now. Conditional on the dispatch still waiting, so a
 * double-click or a race with the automatic pickup resolves to one retry.
 */
export async function reopenDispatchForManualRetry(
	id: string,
	jobPayload: SwarmJob,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'pending',
			jobPayload,
			availableAt: now,
			waitReason: 'manual-retry',
			attempt: 0,
			wakeSeq: sql`${dispatches.wakeSeq} + 1`,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, [...WAITING_DISPATCH_STATES])))
		.returning();
	return rows[0] ?? null;
}

/** Resolve one dispatch by id. */
export async function getDispatchById(id: string): Promise<DispatchRow | undefined> {
	const rows = await getDb().select().from(dispatches).where(eq(dispatches.id, id)).limit(1);
	return rows[0];
}

/** The single active (non-terminal) dispatch for a run row, when one exists. */
export async function getActiveDispatchByRunId(runId: string): Promise<DispatchRow | undefined> {
	const rows = await getDb()
		.select()
		.from(dispatches)
		.where(and(eq(dispatches.runId, runId), inArray(dispatches.state, [...ACTIVE_DISPATCH_STATES])))
		.limit(1);
	return rows[0];
}

/**
 * Every waiting dispatch (`pending`/`retry-scheduled`) — the canonical queue
 * read model (issue #284). Ordered to mirror dispatch intent: eligible-now
 * before scheduled-later, then priority (0 highest), then FIFO on availability.
 */
export async function listWaitingDispatches(projectId?: string): Promise<DispatchRow[]> {
	const where = projectId
		? and(
				eq(dispatches.projectId, projectId),
				inArray(dispatches.state, [...WAITING_DISPATCH_STATES]),
			)
		: inArray(dispatches.state, [...WAITING_DISPATCH_STATES]);
	return getDb()
		.select()
		.from(dispatches)
		.where(where)
		.orderBy(asc(dispatches.priority), asc(dispatches.availableAt), asc(dispatches.createdAt));
}

/**
 * The next capacity-blocked dispatch a freed project slot should wake. With
 * continuation priority on, the oldest SCM continuation wins; otherwise strict
 * FIFO on when the dispatch became pending.
 */
export async function selectNextCapacityDispatch(
	projectId: string,
	prioritizeContinuations: boolean,
): Promise<DispatchRow | undefined> {
	const base = and(
		eq(dispatches.projectId, projectId),
		eq(dispatches.state, 'pending'),
		eq(dispatches.waitReason, 'project-capacity'),
	);
	const rows = await getDb()
		.select()
		.from(dispatches)
		.where(base)
		.orderBy(
			...(prioritizeContinuations
				? [desc(dispatches.continuation), asc(dispatches.availableAt)]
				: [asc(dispatches.availableAt)]),
		)
		.limit(1);
	return rows[0];
}

/**
 * Supersede prior waiting dispatches carrying this coalesce key — the
 * cancel-and-replace half of a bounded recheck. Returns the superseded rows so
 * the caller can best-effort remove their wake-up jobs.
 */
export async function supersedeDispatchesByCoalesceKey(
	coalesceKey: string,
	excludeId?: string,
): Promise<DispatchRow[]> {
	const now = new Date();
	return getDb()
		.update(dispatches)
		.set({
			state: 'completed',
			outcome: 'superseded',
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(dispatches.coalesceKey, coalesceKey),
				inArray(dispatches.state, [...WAITING_DISPATCH_STATES]),
				...(excludeId ? [ne(dispatches.id, excludeId)] : []),
			),
		)
		.returning();
}

/**
 * Fail every leased/running dispatch whose lease expired before `asOf` — the
 * reconciler's dead-worker reclaim. Pass `asOf = undefined` at startup to fail
 * *all* leased/running dispatches (single-worker MVP: a fresh worker owns no
 * in-flight dispatch, so any claim found at boot belongs to a dead process).
 */
export async function failExpiredDispatchLeases(
	reason: string,
	asOf?: Date,
): Promise<DispatchRow[]> {
	const now = new Date();
	return getDb()
		.update(dispatches)
		.set({
			state: 'failed',
			lastError: reason,
			leaseOwner: null,
			leaseExpiresAt: null,
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				inArray(dispatches.state, ['leased', 'running']),
				...(asOf ? [lte(dispatches.leaseExpiresAt, asOf)] : []),
			),
		)
		.returning();
}

/**
 * Cancel every waiting dispatch (optionally project-scoped) — the canonical
 * "clear the queue" operation. Returns the cancelled rows for wake-up cleanup.
 */
export async function cancelAllWaitingDispatches(
	reason: string,
	projectId?: string,
): Promise<DispatchRow[]> {
	const now = new Date();
	const stateCond = inArray(dispatches.state, [...WAITING_DISPATCH_STATES]);
	return getDb()
		.update(dispatches)
		.set({
			state: 'cancelled',
			lastError: reason,
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(projectId ? and(eq(dispatches.projectId, projectId), stateCond) : stateCond)
		.returning();
}

/**
 * Waiting dispatches that need a wake-up (re-)published: every
 * `retry-scheduled` row plus `pending` rows not waiting on project capacity
 * (those are woken by slot releases, not timers). Publishing is idempotent
 * (deterministic wake ids), so returning rows whose wake-up still exists is
 * fine — the re-add is a queue no-op.
 */
export async function listWakeablePendingDispatches(): Promise<DispatchRow[]> {
	return getDb()
		.select()
		.from(dispatches)
		.where(
			sql`(${dispatches.state} = 'retry-scheduled') OR (${dispatches.state} = 'pending' AND (${dispatches.waitReason} IS NULL OR ${dispatches.waitReason} <> 'project-capacity'))`,
		);
}

/** Project ids that currently hold capacity-blocked pending dispatches. */
export async function listProjectsWithCapacityPending(): Promise<string[]> {
	const rows = await getDb()
		.selectDistinct({ projectId: dispatches.projectId })
		.from(dispatches)
		.where(and(eq(dispatches.state, 'pending'), eq(dispatches.waitReason, 'project-capacity')));
	return rows.map((r) => r.projectId);
}

/**
 * Deferred runs with no active dispatch — legacy orphans whose retry intent
 * survives only on the run row (`job_payload`, `next_retry_at`). The startup
 * backfill turns each into a `retry-scheduled` dispatch (issue #284's #269/#279
 * repair).
 */
export async function listDeferredRunsWithoutActiveDispatch(): Promise<
	Array<typeof runs.$inferSelect>
> {
	const active = getDb()
		.select({ runId: dispatches.runId })
		.from(dispatches)
		.where(
			and(
				inArray(dispatches.state, [...ACTIVE_DISPATCH_STATES]),
				sql`${dispatches.runId} IS NOT NULL`,
			),
		);
	return getDb()
		.select()
		.from(runs)
		.where(and(eq(runs.status, 'deferred'), notInArray(runs.id, active)));
}

/** Whether any dispatch rows exist at all — used to gate one-time backfills. */
export async function countDispatches(): Promise<number> {
	const rows = await getDb().select({ n: sql<number>`count(*)::int` }).from(dispatches);
	return rows[0]?.n ?? 0;
}
