/**
 * Poll cadence for the Runs list. The list must keep polling even when no run is
 * currently `running`, because each pipeline phase is a *separate* run row
 * (src/worker/consumer.ts creates one row per phase): a phase transition inserts
 * a brand-new `running` row that a poll-only-while-running loop would never pick
 * up (issue #123). So we poll fast while a run is active and on a slower baseline
 * otherwise — never stopping entirely.
 */
export const RUNS_ACTIVE_REFETCH_MS = 2_000;
export const RUNS_IDLE_REFETCH_MS = 5_000;

/**
 * Row shape we depend on — just the status field. Kept structural so callers can
 * pass the tRPC list payload directly.
 */
interface RunStatusRow {
	status: string;
}

/**
 * Chooses the Runs-list poll interval from the currently-loaded page. Returns a
 * positive number in ALL cases (never `false`/0), so a phase transition surfaces
 * within at most `RUNS_IDLE_REFETCH_MS`.
 */
export function runsListRefetchInterval(data?: { data?: RunStatusRow[] } | null): number {
	const hasRunning = data?.data?.some((run) => run.status === 'running') ?? false;
	return hasRunning ? RUNS_ACTIVE_REFETCH_MS : RUNS_IDLE_REFETCH_MS;
}
