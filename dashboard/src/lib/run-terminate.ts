/**
 * Pure view-logic for the "Terminate" action (issue #166), split out of the
 * run-detail route so it can be unit-tested without a rendered component (the
 * dashboard package tests helpers only — no jsdom; see `dashboard/vitest.config.ts`). The route
 * wires these into the tRPC mutation and confirmation modal.
 */

/**
 * Whether a run can be terminated. Only an in-flight run has something to stop: a
 * `running` run has a live agent to abort, and a `deferred` run has a pending
 * retry job to cancel. A `completed`/`failed` run is already terminal — nothing
 * to do — mirroring the router's guard so the button never offers an action the
 * server would no-op.
 */
export function canTerminateRun(status: string): boolean {
	return status === 'running' || status === 'deferred';
}

/** Confirm-button label: reads "Terminating…" while the mutation is pending. */
export function terminateButtonLabel(isPending: boolean): string {
	return isPending ? 'Terminating…' : 'Terminate';
}

/**
 * The confirmation-modal copy, tailored to the run's state so the user knows
 * exactly what stops: a `running` run kills its agent, a `deferred` run cancels
 * its scheduled retry. Both finalize the run as failed with a user-termination
 * reason and can't be undone.
 */
export function terminateConfirmMessage(status: string): string {
	if (status === 'deferred') {
		return "This cancels the run's scheduled retry and marks it failed. This can't be undone.";
	}
	return "This stops the running agent immediately and marks the run failed. This can't be undone.";
}
