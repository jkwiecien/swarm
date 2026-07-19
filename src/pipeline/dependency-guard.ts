/**
 * Provider-agnostic dependency gate for the pipeline (issue #330).
 *
 * Given a {@link PMProvider} and a work item, returns the still-open prerequisites
 * that should defer the item's Implementation run — so a phase never starts while
 * a task it depends on is unfinished (the out-of-order build that produced the
 * PR #326 ⁄ #327 conflict). It speaks only the PMProvider interface (no GitHub
 * specifics, ai/RULES.md §2), so it works for any provider and no-ops for one
 * that can't model dependencies (`supportsDependencies === false`) — there the
 * human-readable split comment remains the guard.
 */

import { logger } from '@/lib/logger.js';
import { blockedRunMessage, openBlockers } from '@/pm/dependencies.js';
import type { PMProvider, WorkItem, WorkItemBlocker } from '@/pm/types.js';

/**
 * Thrown by a phase that must not run yet because its work item is blocked by an
 * unfinished prerequisite. The worker (`handlePhaseFailure`) treats it specially:
 * a bounded, token-free deferral that re-checks on a slow cadence (never the
 * small rate-limit budget) and only settles failed — posting this message on the
 * board — once the wait budget is exhausted. Its `message` is the human-readable
 * "must be done first" summary.
 */
export class DependencyBlockedError extends Error {
	readonly workItem: WorkItem;
	readonly blockers: WorkItemBlocker[];

	constructor(workItem: WorkItem, blockers: WorkItemBlocker[]) {
		super(blockedRunMessage(blockers));
		this.name = 'DependencyBlockedError';
		this.workItem = workItem;
		this.blockers = blockers;
	}
}

/**
 * The still-open prerequisites blocking `workItem`, or `[]` when nothing gates it.
 *
 * Best-effort by design: if the provider can't model dependencies, or the blocker
 * lookup fails transiently, this returns `[]` (proceed) rather than gating — a
 * spurious network error must not wedge every Implementation run. The native
 * relationship plus the human-readable comment are the durable guards; this is
 * the automated convenience on top.
 */
export async function findOpenBlockers(
	pm: PMProvider,
	workItem: WorkItem,
): Promise<WorkItemBlocker[]> {
	if (!pm.supportsDependencies) return [];
	try {
		return openBlockers(await pm.listBlockers(workItem.id));
	} catch (err) {
		logger.warn('Dependency gate: could not read blockers; proceeding without gating', {
			workItemId: workItem.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}
