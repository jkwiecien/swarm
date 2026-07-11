/**
 * Pure view-logic for the deferred-run "Retry now" action (issue #136), split
 * out of the run-detail route so it can be unit-tested without a rendered
 * component (the web package tests helpers only — no jsdom; see
 * `web/vitest.config.ts`). The route wires these into the tRPC mutation.
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

/** Button label: the in-flight state reads "Retrying…", otherwise "Retry now". */
export function retryButtonLabel(isPending: boolean): string {
	return isPending ? 'Retrying…' : 'Retry now';
}
