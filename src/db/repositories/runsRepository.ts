/**
 * Agent-run history persistence — mirrors the plain-function shape of
 * `projectsRepository.ts` (one `getDb()` per call, no class), trimmed to
 * SWARM's single-user scope (ai/ARCHITECTURE.md "Single-user scope"). This is
 * layer 1 of the "agent-run history" feature (issue #102): the worker records
 * one `runs` row per agent-CLI invocation and, on failure, one `run_logs` row
 * with the captured stdout/stderr. The tRPC API and dashboard UI that read
 * these are follow-up issues.
 *
 * A `runs` row is a flat record of a single pipeline-phase run — there is no
 * join against a work-item cache (SWARM has none; the UI links out via
 * `taskId` + `phase`). Writes here are best-effort from the worker's point of
 * view: a DB hiccup must never fail an actual pipeline run (`consumer.ts`).
 */

import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gt, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { DelegationObservation } from '../../delegation/native.js';
import type { AgentCli } from '../../harness/agent-cli.js';
import type { AgentUsage } from '../../harness/usage.js';
import type { SwarmJob } from '../../queue/jobs.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { getDb } from '../client.js';
import { runLogs, runOutputEvents, runs } from '../schema/runs.js';

export const MAX_RUN_OUTPUT_BYTES = 5_000_000;
export const RUN_OUTPUT_PAGE_SIZE = 200;

export interface RunOutputEventInput {
	stream: 'stdout' | 'stderr';
	content: string;
	emittedAt: Date;
}

type RunRow = typeof runs.$inferSelect;

/** A run's terminal state — everything but the initial `running`. */
type RunStatus = 'running' | 'completed' | 'failed' | 'deferred';

export interface CreateRunInput {
	projectId: string;
	taskId: string;
	phase: TriggerPhase;
	workItemId?: string;
	workItemTitle?: string;
	workItemUrl?: string;
	prNumber?: string;
	prTitle?: string;
	model?: string;
	timeoutMs?: number;
	jobPayload?: SwarmJob;
}

/** Insert a `running` row (the default status); returns the new row's id. */
export async function createRun(input: CreateRunInput): Promise<string> {
	const id = randomUUID();
	const rows = await getDb()
		.insert(runs)
		.values({
			id,
			projectId: input.projectId,
			taskId: input.taskId,
			phase: input.phase,
			workItemId: input.workItemId,
			workItemTitle: input.workItemTitle,
			workItemUrl: input.workItemUrl,
			prNumber: input.prNumber,
			prTitle: input.prTitle,
			model: input.model,
			timeoutMs: input.timeoutMs,
			jobPayload: input.jobPayload,
			agentSessionId: id,
		})
		.returning({ id: runs.id });
	return rows[0].id;
}

/**
 * Whether retention must pin this task's checkout for a resumable deferred run —
 * any phase, any engine (cross-CLI resume). A deferred row that still holds an
 * `agentSessionId` is one the worker intends to resume; pruning its worktree
 * would strip the partial work the resume relies on.
 */
export async function hasResumableDeferredRun(projectId: string, taskId: string): Promise<boolean> {
	const rows = await getDb()
		.select({ id: runs.id })
		.from(runs)
		.where(
			and(
				eq(runs.projectId, projectId),
				eq(runs.taskId, taskId),
				eq(runs.status, 'deferred'),
				isNotNull(runs.agentSessionId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export interface CompleteRunInput {
	status: 'completed' | 'failed' | 'deferred';
	engine?: AgentCli;
	exitCode?: number | null;
	timedOut?: boolean;
	error?: string;
	durationMs?: number;
	nextRetryAt?: Date | null;
	usage?: AgentUsage;
	delegations?: DelegationObservation[];
	agentSessionId?: string | null;
}

/**
 * Finalize a run: set its terminal `status`, `completedAt`, and whichever of the
 * outcome columns the caller passed. Omitted fields are simply left as-is
 * (`engine`/`exitCode` stay null for a run that never produced a result).
 */
export async function completeRun(runId: string, input: CompleteRunInput): Promise<void> {
	await getDb()
		.update(runs)
		.set({
			status: input.status,
			engine: input.engine,
			exitCode: input.exitCode,
			timedOut: input.timedOut,
			error: input.error,
			durationMs: input.durationMs,
			nextRetryAt: input.nextRetryAt,
			usage: input.usage,
			delegations: input.delegations,
			agentSessionId: input.agentSessionId,
			completedAt: new Date(),
		})
		.where(eq(runs.id, runId));
}

/**
 * Reset an existing run row back to `running` for a retry (issue #136), so a
 * re-run reuses its original row rather than inserting a second one — the
 * dashboard then shows one run whose status flips, not two. Clears the terminal
 * columns a prior settle wrote (`completedAt`/`error`/`nextRetryAt`) and the
 * outcome columns (`engine`/`exitCode`/`timedOut`/`durationMs`/`usage`) so the
 * fresh attempt records its own; `model` can be updated if a new one is selected
 * (otherwise left as-is). Returns `true` when a row was updated, `false` when
 * no row matched (it was pruned, or no longer has `fromStatus` when that atomic
 * guard is supplied) — the caller then falls back to `createRun`. Best-effort
 * like the rest of run tracking: the worker swallows/logs any throw.
 *
 * `startedAt` is bumped to now so the row's age reflects *this* attempt, not the
 * original one: the dashboard's live duration measures the current run, and the
 * stale-row reconciliation ({@link failStaleRunningRuns}) — which fails a
 * `running` row once it outlives any plausible timeout — measures each attempt
 * from its own start rather than wrongly reaping a just-retried row for the
 * elapsed time of a hours-old first attempt (issue #165).
 */
export async function resetRunToRunning(
	runId: string,
	jobPayload?: SwarmJob,
	fromStatus?: RunStatus,
	model?: string,
	timeoutMs?: number,
): Promise<boolean> {
	const rows = await getDb()
		.update(runs)
		.set({
			status: 'running',
			startedAt: new Date(),
			completedAt: null,
			error: null,
			nextRetryAt: null,
			engine: null,
			exitCode: null,
			timedOut: false,
			durationMs: null,
			usage: null,
			delegations: null,
			...(jobPayload !== undefined ? { jobPayload } : {}),
			...(model !== undefined ? { model } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		})
		.where(fromStatus ? and(eq(runs.id, runId), eq(runs.status, fromStatus)) : eq(runs.id, runId))
		.returning({ id: runs.id });
	return rows.length > 0;
}

/**
 * Atomically finalize a run as user-terminated (issue #166): flip it to `failed`
 * with the explicit user-termination `reason`, stamp `completedAt`, and clear the
 * retry-shaped columns (`nextRetryAt`, `agentSessionId`) so it can't be picked up
 * or resumed. Preserves the run's other columns (logs live in `run_logs`, which
 * this never touches) so the terminated run keeps whatever it produced.
 *
 * The optional `fromStatus` makes the write a conditional claim: pass `'deferred'`
 * and the update only lands while the row is still deferred — losing the race to
 * a concurrent worker pickup (which flipped it to `running`) returns `false`
 * rather than clobbering an in-flight run, so the caller can fall back to the
 * notify-the-worker path. Returns whether a row was updated.
 */
export async function markRunUserTerminated(
	runId: string,
	reason: string,
	fromStatus?: RunStatus,
): Promise<boolean> {
	const rows = await getDb()
		.update(runs)
		.set({
			status: 'failed',
			error: reason,
			nextRetryAt: null,
			agentSessionId: null,
			completedAt: new Date(),
		})
		.where(fromStatus ? and(eq(runs.id, runId), eq(runs.status, fromStatus)) : eq(runs.id, runId))
		.returning({ id: runs.id });
	return rows.length > 0;
}

/**
 * Resolve the most recent run for one project task and phase. Fresh webhook
 * reruns use this to find a deferred or failed row that can be reused.
 */
export async function getLatestRunForTask(
	projectId: string,
	taskId: string,
	phase: TriggerPhase,
): Promise<RunRow | undefined> {
	const rows = await getDb()
		.select()
		.from(runs)
		.where(and(eq(runs.projectId, projectId), eq(runs.taskId, taskId), eq(runs.phase, phase)))
		.orderBy(desc(runs.startedAt))
		.limit(1);
	return rows[0];
}

/**
 * Upsert the run's captured stdout/stderr. `run_logs.run_id` is unique (one log
 * row per run), so a retry path that re-stores overwrites rather than
 * duplicates — the write stays idempotent.
 */
export async function storeRunLogs(runId: string, stdout: string, stderr: string): Promise<void> {
	await getDb()
		.insert(runLogs)
		.values({ runId, stdout, stderr })
		.onConflictDoUpdate({ target: runLogs.runId, set: { stdout, stderr } });
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	return Buffer.from(value)
		.subarray(0, maxBytes)
		.toString('utf8')
		.replace(/\uFFFD$/, '');
}

/** Append ordered CLI events while keeping each run below its durable retention cap. */
export async function appendRunOutputEvents(
	runId: string,
	events: RunOutputEventInput[],
): Promise<void> {
	if (events.length === 0) return;
	await getDb().transaction(async (tx) => {
		const rows = await tx
			.select({ outputBytes: runs.outputBytes, outputTruncated: runs.outputTruncated })
			.from(runs)
			.where(eq(runs.id, runId))
			.for('update')
			.limit(1);
		const run = rows[0];
		if (!run || run.outputTruncated) return;

		let remaining = MAX_RUN_OUTPUT_BYTES - run.outputBytes;
		let storedBytes = 0;
		let truncated = false;
		const retained: RunOutputEventInput[] = [];
		for (const event of events) {
			const content = truncateUtf8(event.content, remaining);
			const bytes = Buffer.byteLength(content);
			if (content) retained.push({ ...event, content });
			storedBytes += bytes;
			remaining -= bytes;
			if (content !== event.content || remaining === 0) {
				truncated = true;
				break;
			}
		}
		if (retained.length > 0)
			await tx.insert(runOutputEvents).values(retained.map((e) => ({ ...e, runId })));
		await tx
			.update(runs)
			.set({
				outputBytes: sql`${runs.outputBytes} + ${storedBytes}`,
				outputTruncated: truncated,
			})
			.where(eq(runs.id, runId));
	});
}

export async function getRunOutputEvents(
	runId: string,
	after: number,
): Promise<{
	events: Array<{ id: number; stream: 'stdout' | 'stderr'; content: string; emittedAt: Date }>;
	nextCursor: number;
	hasMore: boolean;
	truncated: boolean;
	retentionBytes: number;
}> {
	const db = getDb();
	const [runRows, events] = await Promise.all([
		db.select({ truncated: runs.outputTruncated }).from(runs).where(eq(runs.id, runId)).limit(1),
		db
			.select({
				id: runOutputEvents.id,
				stream: runOutputEvents.stream,
				content: runOutputEvents.content,
				emittedAt: runOutputEvents.emittedAt,
			})
			.from(runOutputEvents)
			.where(and(eq(runOutputEvents.runId, runId), gt(runOutputEvents.id, after)))
			.orderBy(asc(runOutputEvents.id))
			.limit(RUN_OUTPUT_PAGE_SIZE + 1),
	]);
	const page = events.slice(0, RUN_OUTPUT_PAGE_SIZE);
	return {
		events: page,
		nextCursor: page.at(-1)?.id ?? after,
		hasMore: events.length > RUN_OUTPUT_PAGE_SIZE,
		truncated: runRows[0]?.truncated ?? false,
		retentionBytes: MAX_RUN_OUTPUT_BYTES,
	};
}

/**
 * Fail every run still marked `running` — called once at worker startup. A
 * freshly-booted worker owns no in-flight run (the MVP runs a single worker,
 * and this runs before it starts pulling jobs), so any `running` row is a
 * zombie: a phase whose process died — a crash, or the frequent `tsx --watch`
 * restart — before it wrote its terminal status. Left alone those rows show as
 * "running" in the dashboard forever though nothing is running. Flip them to
 * `failed` with an explanatory `error` and a `completedAt`, and return the
 * count reconciled. Best-effort like the rest of run tracking: callers log and
 * continue on error.
 */
export async function failOrphanedRunningRuns(reason: string): Promise<number> {
	const rows = await getDb()
		.update(runs)
		.set({ status: 'failed', error: reason, completedAt: new Date() })
		.where(eq(runs.status, 'running'))
		.returning({ id: runs.id });
	return rows.length;
}

/**
 * Fail every `running` row whose `startedAt` predates `olderThan` — the periodic
 * stale-row reconciliation the worker runs *while serving jobs* (issue #165),
 * the running-worker counterpart to {@link failOrphanedRunningRuns}'s
 * startup-only sweep. Unlike that one it cannot fail *all* `running` rows (a
 * genuinely in-flight phase has one), so it only reaps rows old enough that no
 * live agent could still be behind them: every agent is killed at its wall-clock
 * timeout ({@link resetRunToRunning} keeps `startedAt` per-attempt), so a row
 * still `running` well past the largest configured timeout is a settled phase
 * whose finalize never landed (its process died, but the worker survived). Flip
 * those to `failed` with an explanatory `error`; return the count reconciled.
 * Best-effort like the rest of run tracking: callers log and continue on error.
 */
export async function failStaleRunningRuns(
	defaultTimeoutMs: number,
	marginMs: number,
	reason: string,
): Promise<number> {
	const rows = await getDb()
		.update(runs)
		.set({ status: 'failed', error: reason, completedAt: new Date() })
		.where(
			and(
				eq(runs.status, 'running'),
				sql`${runs.startedAt} < NOW() - (COALESCE(${runs.timeoutMs}, ${defaultTimeoutMs}) + ${marginMs}) * INTERVAL '1 millisecond'`,
			),
		)
		.returning({ id: runs.id });
	return rows.length;
}

export interface ListRunsFilter {
	projectId?: string;
	status?: RunStatus;
	phase?: TriggerPhase;
	limit: number;
	offset: number;
}

/**
 * Paginated, filtered list of runs ordered by `startedAt` desc. `total` is the
 * count of the *filtered* set (not the page), so a UI can render page counts;
 * it runs as a separate query against the same conditions. Sort order is fixed
 * (`startedAt desc`) — sortable columns and date-range filters are out of scope.
 */
export async function listRunsFromDb(
	filter: ListRunsFilter,
): Promise<{ data: RunRow[]; total: number }> {
	const conditions: SQL[] = [];
	if (filter.projectId) conditions.push(eq(runs.projectId, filter.projectId));
	if (filter.status) conditions.push(eq(runs.status, filter.status));
	if (filter.phase) conditions.push(eq(runs.phase, filter.phase));
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const db = getDb();
	const data = await db
		.select()
		.from(runs)
		.where(where)
		.orderBy(desc(runs.startedAt))
		.limit(filter.limit)
		.offset(filter.offset);
	const totalRows = await db.select({ total: count() }).from(runs).where(where);
	return { data, total: totalRows[0].total };
}

/** Resolve a single run by its id. Returns `undefined` when unknown. */
export async function getRunByIdFromDb(id: string): Promise<RunRow | undefined> {
	const rows = await getDb().select().from(runs).where(eq(runs.id, id)).limit(1);
	return rows[0];
}

/**
 * Fetch a run's captured stdout/stderr. Returns `undefined` when the run has no
 * `run_logs` row (a run that succeeded, or failed before its output was stored).
 */
export async function getRunLogsFromDb(
	runId: string,
): Promise<{ stdout: string | null; stderr: string | null } | undefined> {
	const rows = await getDb()
		.select({ stdout: runLogs.stdout, stderr: runLogs.stderr })
		.from(runLogs)
		.where(eq(runLogs.runId, runId))
		.limit(1);
	return rows[0];
}
