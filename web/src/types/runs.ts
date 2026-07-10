export interface RunRow {
	id: string;
	projectId: string;
	taskId: string;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	prNumber: string | null;
	phase: string;
	engine: string | null;
	model: string | null;
	status: string;
	exitCode: number | null;
	timedOut: boolean;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
}
