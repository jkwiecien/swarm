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
	exitCode: number | null;
	timedOut: boolean;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	nextRetryAt: string | null;
	durationMs: number | null;
	usage: AgentUsage | null;
	jobPayload: unknown | null;
}
