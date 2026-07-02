/**
 * PM Provider abstraction — the shared, provider-agnostic contract the router,
 * trigger, and dispatch code program against so none of them ever branch on a
 * concrete provider (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Mirrors Cascade's `src/pm/types.ts`, scoped down to SWARM's MVP: Cascade
 * ships Trello/JIRA/Linear and a much wider surface (checklists, attachments,
 * custom fields, PR linking, discovery); SWARM has exactly one PM provider —
 * GitHub Projects (v2) — and the pipeline only needs four operations. The rest
 * are deliberately left out until a second provider or a phase actually needs
 * them; adding them speculatively would be a standards violation
 * (ai/CODING_STANDARDS.md "Comments" / "don't build it speculatively").
 *
 * This file defines *types only* — the adapter that implements it against the
 * GitHub Projects GraphQL API lives under
 * `src/integrations/pm/github-projects/` and is a separate Phase-2 issue.
 *
 * IDs are plain `string` at this interface, on purpose: the contract is
 * provider-agnostic, so it can't name GitHub-specific branded types
 * (`src/pm/ids.ts`). The adapter brands them internally at its boundary
 * (`parseWorkItemId` on the way in, `unwrap` on the way out) — same split
 * Cascade uses, where the shared interface speaks `string` and each adapter
 * narrows to its own branded IDs.
 */

export type PMType = 'github-projects';

export interface WorkItemLabel {
	id: string;
	name: string;
	color?: string;
}

export interface WorkItem {
	/** The provider-native item ID — a GitHub Projects v2 item node ID. */
	id: string;
	title: string;
	description: string;
	/** Web URL of the backing Issue/PR the card wraps. */
	url: string;
	/** Human-readable Status option name (e.g. `In progress`) when available. */
	status?: string;
	/**
	 * Provider-native Status option ID (a GitHub Projects `SingleSelectOptionId`,
	 * e.g. `47fc9ee4`) when available. Stable across renames — prefer this over
	 * `status` for logic; `status` is display-only.
	 */
	statusId?: string;
	labels: WorkItemLabel[];
	/** ISO 8601 creation timestamp as reported by the provider, when available. */
	createdAt?: string;
	/** ISO 8601 last-update timestamp as reported by the provider, when available. */
	updatedAt?: string;
}

/** Optional server-side filters for {@link PMProvider.listWorkItems}. */
export interface ListWorkItemsFilter {
	/**
	 * A canonical SWARM pipeline status key (e.g. `backlog`, `planning`, `todo`,
	 * `inProgress`, `inReview`, `done` — `PM_STATUS_KEYS` in `src/pm/pipeline.ts`
	 * is the source of truth) — the same keys used in the config's
	 * `statusOptions` map. The adapter resolves it to a `SingleSelectOptionId`
	 * and filters the board's items by that Status option. Omit to list every
	 * item on the board.
	 */
	status?: string;
}

/**
 * The contract every SWARM PM provider implements. MVP surface = the four
 * operations the pipeline (ai/ARCHITECTURE.md "Pipeline phases") needs to read
 * the board, move a card through it, and report back.
 */
export interface PMProvider {
	readonly type: PMType;

	/**
	 * Read a single work item by its provider-native ID.
	 *
	 * Throws if the ID doesn't resolve — a work item ID SWARM holds comes from a
	 * webhook payload or a prior board read, so a non-resolving ID is bad input,
	 * not a soft "not found" (ai/CODING_STANDARDS.md "Error handling").
	 */
	getWorkItem(id: string): Promise<WorkItem>;

	/**
	 * List work items on the board, optionally filtered by status. A SWARM
	 * project maps to exactly one board (ai/ARCHITECTURE.md "Single-user scope"),
	 * so there's no container argument — unlike Cascade, whose providers span
	 * multiple Trello lists / JIRA projects.
	 */
	listWorkItems(filter?: ListWorkItemsFilter): Promise<WorkItem[]>;

	/**
	 * Move a work item to a new pipeline status. `status` is a canonical SWARM
	 * pipeline key (e.g. `inProgress`), which the adapter resolves through the
	 * config's `statusOptions` map to a `SingleSelectOptionId` and writes to the
	 * board's Status field via `updateProjectV2ItemFieldValue`
	 * (docs/github-projects-v2-api.md §4).
	 */
	moveWorkItem(id: string, status: string): Promise<void>;

	/**
	 * Post a comment carrying agent output (a plan, review notes) and return the
	 * created comment's ID.
	 *
	 * GitHub Projects v2 items have **no native comment thread**
	 * (docs/github-projects-v2-api.md §4 → Comments), so the comment lands on the
	 * Issue/PR the item's card wraps, not on the board. `id` is still the work
	 * item ID; resolving it to the backing Issue/PR is the adapter's job.
	 */
	addComment(id: string, text: string): Promise<string>;
}
