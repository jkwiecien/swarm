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

import { and, count, desc, eq, type SQL } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { getDb } from '../client.js';
import { runLogs, runs } from '../schema/runs.js';

type RunRow = typeof runs.$inferSelect;

/** A run's terminal state — everything but the initial `running`. */
type RunStatus = 'running' | 'completed' | 'failed' | 'deferred';

export interface CreateRunInput {
	projectId: string;
	taskId: string;
	phase: TriggerPhase;
	workItemId?: string;
	prNumber?: string;
	model?: string;
}

/** Insert a `running` row (the default status); returns the new row's id. */
export async function createRun(input: CreateRunInput): Promise<string> {
	const rows = await getDb()
		.insert(runs)
		.values({
			projectId: input.projectId,
			taskId: input.taskId,
			phase: input.phase,
			workItemId: input.workItemId,
			prNumber: input.prNumber,
			model: input.model,
		})
		.returning({ id: runs.id });
	return rows[0].id;
}

export interface CompleteRunInput {
	status: 'completed' | 'failed' | 'deferred';
	engine?: AgentCli;
	exitCode?: number | null;
	timedOut?: boolean;
	error?: string;
	durationMs?: number;
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
			completedAt: new Date(),
		})
		.where(eq(runs.id, runId));
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
