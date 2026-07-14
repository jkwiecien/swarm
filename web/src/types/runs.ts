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
