/**
 * SWARM pipeline phases and the PM-status → phase mapping — provider-agnostic,
 * so the trigger and dispatch code never branch on a concrete PM provider
 * (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Only two of the four pipeline phases (ai/ARCHITECTURE.md "Pipeline phases")
 * are entered by a *board status change*: Planning (item → "Planning") and
 * Implementation (item → "In Progress"). The other two — Review and
 * Respond-to-review — are driven by SCM events (a PR opening / a check suite
 * completing / a review being submitted), not by the PM board, so they have no
 * entry in this map. That asymmetry is intentional: this map is exactly the set
 * of statuses whose transition should fire a PM `status-changed` trigger.
 *
 * Keys are the canonical SWARM pipeline status keys (the same ones the config's
 * `statusOptions` map and `ListWorkItemsFilter.status` use — `src/pm/types.ts`),
 * not a provider's opaque option IDs. Mapping a provider's option ID to one of
 * these keys is the adapter's job (each provider owns that translation).
 */

/** A pipeline phase that a board status change can trigger. */
export type PipelinePhase = 'planning' | 'implementation';

/**
 * Canonical pipeline status key → the phase entering that status triggers.
 * A status key absent here (e.g. `backlog`, `inReview`, `done`) is a valid
 * board status that simply doesn't start a PM-driven phase.
 */
export const PM_STATUS_TO_PHASE: Readonly<Record<string, PipelinePhase>> = {
	planning: 'planning',
	inProgress: 'implementation',
};

/**
 * The pipeline phase a canonical status key triggers, or `undefined` when the
 * status doesn't start a PM-driven phase — a "not applicable" lookup, not an
 * error (ai/CODING_STANDARDS.md "Error handling").
 */
export function resolvePipelinePhaseForStatusKey(statusKey: string): PipelinePhase | undefined {
	return PM_STATUS_TO_PHASE[statusKey];
}
