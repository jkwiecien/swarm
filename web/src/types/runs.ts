import { z } from 'zod';

/**
 * Run status/phase filter values, mirroring the router's `RunStatusEnum`/
 * `RunPhaseEnum` (`src/api/routers/runs.ts`). The web package doesn't import
 * server modules, so these are re-declared here as the single source for the
 * UI layer — reused by both the global `/runs` route search schema and the
 * project-scoped Runs panel so a new phase/status only has to be added once.
 * Zod is the source of truth per `ai/CODING_STANDARDS.md`; the types are
 * `z.infer`'d rather than hand-written.
 */
export const runStatusFilterSchema = z.enum(['running', 'completed', 'failed', 'deferred']);
export type RunStatusFilter = z.infer<typeof runStatusFilterSchema>;

export const runPhaseFilterSchema = z.enum([
	'planning',
	'implementation',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);
export type RunPhaseFilter = z.infer<typeof runPhaseFilterSchema>;

/**
 * Mirrors the server `runs.queued` contract (`QueuedRunSchema`,
 * `src/queue/queued-runs.ts`) for a job enqueued in BullMQ but not yet picked up
 * by the worker (issue #234). The web package doesn't import server modules, so
 * this re-declares the shape here the same way `runStatusFilterSchema` mirrors
 * the router's status enum — keep it exactly in step with the server schema.
 *
 * `phaseHint` is best-effort (derived without a GitHub lookup), so it is NOT the
 * same closed set as {@link runPhaseFilterSchema}: `board` covers Planning/Impl
 * before authoritative dispatch, and `unknown` is a real value.
 */
export const queuedPhaseHintSchema = z.enum([
	'board',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
	'unknown',
]);
export type QueuedPhaseHint = z.infer<typeof queuedPhaseHintSchema>;

/** Which BullMQ pending set a job was read from (mirrors `PendingJobStateSchema`). */
export const queuedRunStateSchema = z.enum(['waiting', 'prioritized', 'delayed']);
export type QueuedRunState = z.infer<typeof queuedRunStateSchema>;

export const queuedRunSchema = z.object({
	jobId: z.string(),
	projectId: z.string(),
	type: z.enum(['github', 'github-projects']),
	state: queuedRunStateSchema,
	phaseHint: queuedPhaseHintSchema,
	/** `github` jobs only — `owner/repo`. */
	repo: z.string().optional(),
	/** `github` jobs only — the PR/issue number. */
	prNumber: z.string().optional(),
	/** `github-projects` jobs only — the opaque board item node id. */
	workItemNodeId: z.string().optional(),
	/** `github-projects` jobs only — `Issue` | `PullRequest` | `DraftIssue`. */
	contentType: z.string().optional(),
	/** Resolved backing Issue/PR title for a board job, when available. */
	workItemTitle: z.string().optional(),
	/** Resolved backing Issue/PR URL for a board job, when available. */
	workItemUrl: z.string().optional(),
	/** Effective BullMQ priority; 0 is highest. */
	priority: z.number().int().nonnegative(),
	/** ISO 8601 — when the job was enqueued. */
	enqueuedAt: z.string(),
	/** ISO 8601 — `delayed` jobs only, scheduled run time. */
	runsAt: z.string().optional(),
});
export type QueuedRun = z.infer<typeof queuedRunSchema>;

/**
 * Mirrors `AgentUsage` (`src/harness/usage.ts`) — the web package doesn't
 * import server modules, so this hand-mirrors the shape the same way `RunRow`
 * hand-mirrors the DB row.
 */
export interface AgentUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
}

export interface RunRow {
	id: string;
	projectId: string;
	taskId: string;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	prNumber: string | null;
	prTitle: string | null;
	phase: string;
	engine: string | null;
	model: string | null;
	/** Explicitly requested reasoning level; null = CLI/model default (issue #180). */
	reasoning: string | null;
	status: string;
	/**
	 * Verdict a completed Review run submitted (`approve`/`request-changes`/
	 * `comment`, issue #218); null for non-review phases and pre-existing rows.
	 * Drives the verdict badge a completed Review row shows instead of "Completed".
	 */
	reviewVerdict: string | null;
	exitCode: number | null;
	timedOut: boolean;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	nextRetryAt: string | null;
	durationMs: number | null;
	usage: AgentUsage | null;
	jobPayload: unknown | null;
	/**
	 * Captured agent-session id kept on a resumable `deferred` run, so its pending
	 * retry can continue the CLI session rather than start fresh (issue #227).
	 * Non-null only while `deferred` and resumable — the server clears it for a
	 * non-resumable deferral and a terminal `failed` run (see the router's
	 * `hasResumableDeferredRun` guard). Mirrors the `agent_session_id` column.
	 */
	agentSessionId: string | null;
}
