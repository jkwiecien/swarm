/**
 * The **assignee → SWARM user** seam: the one place that turns a work item's
 * provider-neutral assignee (`WorkItemAssignee`, `src/pm/types.ts`) into a
 * `SwarmUser`. Routing code (ADR-001's execution-affinity rule, issue #130) asks
 * this instead of reading a GitHub login and guessing, so no GitHub identity
 * shape ever reaches pipeline/scheduler code (ai/RULES.md §2) and a Jira/Linear
 * provider works through the same call.
 *
 * `provider` is the caller's `PMProvider.type` — passed in rather than inferred
 * here, so this module stays provider-agnostic. Resolution is unambiguous by
 * construction: a `(provider, handle)` pair maps to at most one SWARM user
 * (`user_identities`' unique index). An unlinked handle resolves to `undefined`
 * — a not-found lookup, not an error (ai/CODING_STANDARDS.md "Error handling"),
 * matching the rest of the identity read model (`./service.ts`,
 * `./membership-service.ts`).
 *
 * Reads only, and it decides nothing about routing: *which* assignee wins when
 * an item has several, and what an unresolved assignee means for dispatch, are
 * the eligibility gate's calls (#130 Phase 3), not this seam's.
 */

import { findUserIdByIdentity } from '../db/repositories/userIdentitiesRepository.js';
import type { WorkItem, WorkItemAssignee } from '../pm/types.js';
import type { SwarmUser } from './schema.js';
import { getUser } from './service.js';

/**
 * The SWARM user who owns this assignee's handle on `provider`, or `undefined`
 * when the handle is not linked to any user (or is linked to a user that has
 * since been deleted).
 */
export async function resolveUserForAssignee(
	assignee: WorkItemAssignee,
	provider: string,
): Promise<SwarmUser | undefined> {
	const userId = await findUserIdByIdentity(provider, assignee.handle);
	return userId ? getUser(userId) : undefined;
}

/** A work item's assignee that resolved to a SWARM user, paired with that user. */
export interface ResolvedAssignee {
	user: SwarmUser;
	assignee: WorkItemAssignee;
}

/**
 * The item's first assignee that maps to a SWARM user, or `undefined` when it
 * has no assignees or none of them are linked. "First" is the provider's own
 * ordering — a deliberate, documented tie-break, not a policy: an item assigned
 * to several linked users is a routing question #130 Phase 3 answers, and it can
 * consume {@link resolveUserForAssignee} per assignee if it needs the full set.
 */
export async function resolveAssignedUser(
	workItem: Pick<WorkItem, 'assignees'>,
	provider: string,
): Promise<ResolvedAssignee | undefined> {
	for (const assignee of workItem.assignees) {
		const user = await resolveUserForAssignee(assignee, provider);
		if (user) return { user, assignee };
	}
	return undefined;
}
