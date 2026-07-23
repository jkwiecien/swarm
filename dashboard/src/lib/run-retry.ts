/**
 * Pure view-logic for the deferred-run "Retry now" action (issue #136), split
 * out of the run-detail route so it can be unit-tested without a rendered
 * component (the dashboard package tests helpers only — no jsdom; see
 * `dashboard/vitest.config.ts`). The route wires these into the tRPC mutation.
 */

/**
 * Whether a run can be retried now. Only a `deferred` run has a pending BullMQ
 * retry job to promote (`runs.retryNow`); a `running` run is already going, and
 * a `completed`/`failed` run has nothing pending to fire. Mirrors the router's
 * `deferred`-only guard so the button never offers an action the server rejects.
 */
export function canRetryRun(status: string): boolean {
	return status === 'deferred' || status === 'failed';
}

/**
 * The two shapes the primary retry action takes (issue #227):
 * - `resume` — continue the captured CLI session a deferred run preserved.
 * - `retry`  — start a fresh agent session from scratch.
 */
export type RetryActionKind = 'resume' | 'retry';

/**
 * Which primary action the run offers. A `deferred` run that still holds a
 * captured `agentSessionId` is one whose pending retry will *continue* that
 * session (the exact condition the router pins the worktree for —
 * `hasResumableDeferredRun`: `status = 'deferred' AND agent_session_id IS NOT
 * NULL`), so it's a "resume". Every other retryable run — a non-resumable
 * deferred run (session cleared) or a terminally `failed` run — relaunches from
 * scratch, so it's a plain "retry". Mirroring the server's own guard keeps the
 * green Resume button from ever promising a resume the retry path won't perform.
 */
export function retryActionKind(
	status: string,
	agentSessionId: string | null,
	recovery?: { state: 'preserved' | 'recovered' | 'blocked' } | null,
): RetryActionKind {
	if (status === 'deferred' && agentSessionId !== null) return 'resume';
	if (status === 'failed' && recovery?.state === 'preserved') return 'resume';
	return 'retry';
}

/**
 * Button label for the primary action. A resume reads "Resume"/"Resuming…"; a
 * fresh retry keeps the original "Retry now"/"Retrying…". The in-flight variant
 * is shown while the mutation is pending.
 */
export function retryButtonLabel(kind: RetryActionKind, isPending: boolean): string {
	if (kind === 'resume') return isPending ? 'Resuming…' : 'Resume';
	return isPending ? 'Retrying…' : 'Retry now';
}
