/**
 * Config for the dependency re-check deferral (issue #330).
 *
 * An Implementation whose work item is `blocked by` an unfinished prerequisite is
 * deferred as a **token-free** re-check — the dependency gate runs before any
 * worktree or agent, so re-checking costs one PMProvider read and zero model
 * tokens (the same agent-less pattern as `merge-automation`). Because it's cheap,
 * it re-checks on a slow cadence over a long window, then gives up so a run can't
 * wait forever on an abandoned prerequisite. Mirrors `job-freshness.ts`'s
 * env-parse shape.
 */

/** Re-check interval when `SWARM_DEPENDENCY_RECHECK_MS` is unset (5 minutes). */
export const DEFAULT_DEPENDENCY_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Total wait budget when `SWARM_DEPENDENCY_MAX_WAIT_MS` is unset (~7 days). */
export const DEFAULT_DEPENDENCY_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

function resolvePositiveIntMs(name: string, raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer, got '${raw}'`);
	}
	return value;
}

export function resolveDependencyRecheckIntervalMs(
	raw = process.env.SWARM_DEPENDENCY_RECHECK_MS,
): number {
	return resolvePositiveIntMs(
		'SWARM_DEPENDENCY_RECHECK_MS',
		raw,
		DEFAULT_DEPENDENCY_RECHECK_INTERVAL_MS,
	);
}

export function resolveDependencyMaxWaitMs(raw = process.env.SWARM_DEPENDENCY_MAX_WAIT_MS): number {
	return resolvePositiveIntMs('SWARM_DEPENDENCY_MAX_WAIT_MS', raw, DEFAULT_DEPENDENCY_MAX_WAIT_MS);
}

/**
 * How many re-checks fit in the wait budget at the configured interval — the cap
 * after which a still-blocked run settles failed. At least 1, so a tiny budget
 * still gets one real attempt.
 */
export function maxDependencyRechecks(intervalMs: number, maxWaitMs: number): number {
	return Math.max(1, Math.floor(maxWaitMs / intervalMs));
}
