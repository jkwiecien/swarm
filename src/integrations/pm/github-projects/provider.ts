/**
 * GitHubProjectsPMProvider — the concrete `PMProvider` (`src/pm/types.ts`) for
 * GitHub Projects (v2), net-new to SWARM (Cascade ships Trello/JIRA/Linear, not
 * GitHub Projects — ai/ARCHITECTURE.md "PM: GitHub Projects"). It's what lets
 * the Planning and Implementation phases read the card that triggered them,
 * post their output on the linked Issue, and move the card forward.
 *
 * Every operation is GraphQL — Projects v2 has no REST surface for item/field
 * reads or writes — except comments, which land on the backing Issue/PR via
 * REST because Projects items have no native comment thread
 * (docs/github-projects-v2-api.md §3-4). The exact queries/mutation below are
 * the ones that doc verified against the real board.
 *
 * Credentials are never passed in: each method runs its GitHub work inside
 * `GitHubSCMIntegration.withPersonaCredentials(project, 'implementer', …)`, so
 * the scoped Octokit client (`getScopedClient`) authenticates as the
 * implementer persona — the bot that owns board interactions. Moving a card or
 * commenting as the implementer is also what the router's loop-prevention drops
 * as self-authored, so the pipeline doesn't re-trigger itself.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import type { PMProvider, PMType, WorkItem, WorkItemLabel } from '../../../pm/types.js';
import { getScopedClient } from '../../scm/github/client.js';
import { GitHubSCMIntegration } from '../../scm/github/scm-integration.js';

/** Shape of the `content` node a Projects item wraps (Issue / PullRequest). */
interface ContentNode {
	__typename?: string;
	number?: number;
	title?: string;
	body?: string | null;
	url?: string;
	repository?: { nameWithOwner?: string };
	labels?: { nodes?: Array<{ id?: string; name?: string; color?: string }> };
}

interface ItemNode {
	id?: string;
	content?: ContentNode | null;
	fieldValueByName?: { name?: string; optionId?: string } | null;
	createdAt?: string;
	updatedAt?: string;
}

interface GetItemResponse {
	node?: ItemNode | null;
}

/** One page of the board's items, for {@link GitHubProjectsPMProvider.listWorkItems}. */
interface ListItemsResponse {
	node?: {
		items?: {
			nodes?: ItemNode[] | null;
			pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
		} | null;
	} | null;
}

/**
 * A Projects item read, plus the backing Issue/PR coordinates the item itself
 * doesn't expose through the provider-agnostic {@link WorkItem} (which speaks no
 * GitHub-specific fields). Kept internal to the adapter.
 */
interface ResolvedItem {
	workItem: WorkItem;
	owner?: string;
	repo?: string;
	contentNumber?: number;
}

/** Read one item, its Status option, and its backing Issue/PR in one round-trip. */
const GET_ITEM_QUERY = /* GraphQL */ `
	query($itemId: ID!) {
		node(id: $itemId) {
			... on ProjectV2Item {
				id
				createdAt
				updatedAt
				content {
					__typename
					... on Issue {
						number title body url
						repository { nameWithOwner }
						labels(first: 20) { nodes { id name color } }
					}
					... on PullRequest {
						number title body url
						repository { nameWithOwner }
						labels(first: 20) { nodes { id name color } }
					}
				}
				fieldValueByName(name: "Status") {
					... on ProjectV2ItemFieldSingleSelectValue { name optionId }
				}
			}
		}
	}
`;

const LIST_ITEMS_QUERY = /* GraphQL */ `
	query($projectId: ID!, $cursor: String) {
		node(id: $projectId) {
			... on ProjectV2 {
				items(first: 100, after: $cursor) {
					pageInfo { hasNextPage endCursor }
					nodes {
						id
						createdAt
						updatedAt
						content {
							__typename
							... on Issue {
								number title body url
								repository { nameWithOwner }
								labels(first: 20) { nodes { id name color } }
							}
							... on PullRequest {
								number title body url
								repository { nameWithOwner }
								labels(first: 20) { nodes { id name color } }
							}
						}
						fieldValueByName(name: "Status") {
							... on ProjectV2ItemFieldSingleSelectValue { name optionId }
						}
					}
				}
			}
		}
	}
`;

/**
 * Set a single-select field on an item (docs/github-projects-v2-api.md §4). The
 * only mutation SWARM writes — status transitions are the whole PM surface it
 * needs.
 */
const MOVE_ITEM_MUTATION = /* GraphQL */ `
	mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
		updateProjectV2ItemFieldValue(input: {
			projectId: $projectId
			itemId: $itemId
			fieldId: $fieldId
			value: { singleSelectOptionId: $optionId }
		}) {
			projectV2Item { id }
		}
	}
`;

function mapLabels(content: ContentNode | null | undefined): WorkItemLabel[] {
	const nodes = content?.labels?.nodes ?? [];
	return nodes
		.filter((n): n is { id: string; name: string; color?: string } => !!n?.id && !!n.name)
		.map((n) => ({ id: n.id, name: n.name, color: n.color }));
}

function ownerRepoFrom(content: ContentNode | null | undefined): {
	owner?: string;
	repo?: string;
} {
	const nameWithOwner = content?.repository?.nameWithOwner;
	if (!nameWithOwner) return {};
	const [owner, repo] = nameWithOwner.split('/');
	return { owner, repo };
}

function toResolvedItem(item: ItemNode): ResolvedItem {
	const content = item.content ?? undefined;
	const { owner, repo } = ownerRepoFrom(content);
	const workItem: WorkItem = {
		id: item.id ?? '',
		title: content?.title ?? '',
		description: content?.body ?? '',
		url: content?.url ?? '',
		status: item.fieldValueByName?.name,
		statusId: item.fieldValueByName?.optionId,
		labels: mapLabels(content),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
	return { workItem, owner, repo, contentNumber: content?.number };
}

export class GitHubProjectsPMProvider implements PMProvider {
	readonly type: PMType = 'github-projects';

	private readonly scm = new GitHubSCMIntegration();

	constructor(private readonly project: ProjectConfig) {}

	/** Run `fn` with the implementer persona's GitHub client bound to scope. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		return this.scm.withPersonaCredentials(this.project, 'implementer', fn);
	}

	private async resolveItem(id: string): Promise<ResolvedItem> {
		return this.run(async () => {
			const data = await getScopedClient().graphql<GetItemResponse>(GET_ITEM_QUERY, {
				itemId: id,
			});
			const item = data.node;
			// A non-resolving item ID is bad input, not a soft miss: the ID came from
			// a webhook or a prior board read (ai/CODING_STANDARDS.md "Error handling").
			if (!item?.id) {
				throw new Error(`GitHub Projects item '${id}' did not resolve`);
			}
			return toResolvedItem(item);
		});
	}

	async getWorkItem(id: string): Promise<WorkItem> {
		return (await this.resolveItem(id)).workItem;
	}

	async listWorkItems(filter?: { status?: string }): Promise<WorkItem[]> {
		// The board's small today (ai/ARCHITECTURE.md "Single-user scope"), but
		// `items` is a paginated connection — walk every page so a board that
		// outgrows one page (100 items) isn't silently truncated. Status filtering
		// is client-side against the canonical key the caller passes, resolved to
		// this board's option ID.
		let wantedOptionId: string | undefined;
		if (filter?.status !== undefined) {
			wantedOptionId = this.project.githubProjects.statusOptions[filter.status];
			// A status key with no mapping is a config/logic error, not "match
			// everything": leaving it undefined would fall through to the no-filter
			// path below and return all items. Fail loudly, matching moveWorkItem
			// (ai/CODING_STANDARDS.md "Error handling").
			if (!wantedOptionId) {
				throw new Error(
					`Cannot list items: status '${filter.status}' has no option ID in the project's statusOptions map`,
				);
			}
		}
		return this.run(async () => {
			const nodes: ItemNode[] = [];
			let cursor: string | undefined;
			for (;;) {
				const data = await getScopedClient().graphql<ListItemsResponse>(LIST_ITEMS_QUERY, {
					projectId: this.project.githubProjects.projectId,
					cursor,
				});
				const page = data.node?.items;
				nodes.push(...(page?.nodes ?? []));
				const pageInfo = page?.pageInfo;
				// Guard against a malformed response that claims another page but hands
				// back no cursor — advancing on `undefined` would refetch page one forever.
				if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
				// And against a server that claims another page while handing back the
				// same cursor we just used — advancing to it would loop forever too. This
				// keeps the loop provably terminating regardless of server behavior.
				if (pageInfo.endCursor === cursor) break;
				cursor = pageInfo.endCursor;
			}
			return nodes
				.filter((n): n is ItemNode => !!n?.id)
				.map((n) => toResolvedItem(n).workItem)
				.filter((wi) => wantedOptionId === undefined || wi.statusId === wantedOptionId);
		});
	}

	async moveWorkItem(id: string, status: string): Promise<void> {
		const { projectId, statusFieldId, statusOptions } = this.project.githubProjects;
		const optionId = statusOptions[status];
		if (!optionId) {
			// A status the board mapping can't resolve is a config/logic error, not a
			// value to silently write — fail loudly (ai/CODING_STANDARDS.md).
			throw new Error(
				`Cannot move item '${id}': status '${status}' has no option ID in the project's statusOptions map`,
			);
		}
		await this.run(async () => {
			await getScopedClient().graphql(MOVE_ITEM_MUTATION, {
				projectId,
				itemId: id,
				fieldId: statusFieldId,
				optionId,
			});
		});
		logger.debug('pm: moved work item', { itemId: id, status });
	}

	async addComment(id: string, text: string): Promise<string> {
		const resolved = await this.resolveItem(id);
		const { owner, repo, contentNumber } = resolved;
		// Projects items have no comment thread; the comment lands on the backing
		// Issue/PR (docs/github-projects-v2-api.md §4). A draft item has no backing
		// Issue, so there's nowhere to post — that's a bad target, not a soft miss.
		if (!owner || !repo || contentNumber == null) {
			throw new Error(
				`Cannot comment on item '${id}': it has no backing Issue/PR to post to (likely a draft item)`,
			);
		}
		return this.run(async () => {
			const { data } = await getScopedClient().issues.createComment({
				owner,
				repo,
				issue_number: contentNumber,
				body: text,
			});
			return String(data.id);
		});
	}
}

/**
 * Build the GitHub Projects PM provider for a project. The one construction
 * seam callers (the worker's phase dispatch, the trigger handlers) use, so they
 * depend on the `PMProvider` interface rather than the concrete class.
 */
export function createGitHubProjectsProvider(project: ProjectConfig): PMProvider {
	return new GitHubProjectsPMProvider(project);
}
