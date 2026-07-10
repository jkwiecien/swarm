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
import type {
	CreateWorkItemInput,
	PMProvider,
	PMType,
	UpdateWorkItemPatch,
	WorkItem,
	WorkItemLabel,
} from '../../../pm/types.js';
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

/**
 * Add an existing Issue/PR (by its content node ID) to the board, returning the
 * new item's node ID. Paired with {@link MOVE_ITEM_MUTATION} to place the item
 * in a starting Status — the two writes {@link GitHubProjectsPMProvider.createWorkItem}
 * makes after creating the backing Issue via REST.
 */
const ADD_PROJECT_ITEM_MUTATION = /* GraphQL */ `
	mutation($projectId: ID!, $contentId: ID!) {
		addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
			item { id }
		}
	}
`;

interface AddProjectItemResponse {
	addProjectV2ItemById?: { item?: { id?: string } | null } | null;
}

/** Default label color (GitHub's neutral grey) for a SWARM-created label. */
const DEFAULT_LABEL_COLOR = 'ededed';

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

	async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
		const [owner, repo] = this.project.repo.split('/');
		const { projectId, statusFieldId, statusOptions } = this.project.githubProjects;
		const optionId = statusOptions[input.status];
		if (!optionId) {
			// Same fail-loud contract as moveWorkItem: an unmappable status is a
			// config/logic error, not a value to silently write (ai/CODING_STANDARDS.md).
			throw new Error(
				`Cannot create item: status '${input.status}' has no option ID in the project's statusOptions map`,
			);
		}
		const labels = input.labels ?? [];
		return this.run(async () => {
			const client = getScopedClient();
			// A label referenced on a new issue must already exist, so ensure each
			// before creating — otherwise the whole create fails on an unknown label.
			for (const name of labels) {
				await ensureLabel(owner, repo, name);
			}
			const { data: issue } = await client.issues.create({
				owner,
				repo,
				title: input.title,
				body: input.description,
				labels,
			});
			// Add the fresh Issue to the board, then place it in its starting Status —
			// two writes, since addProjectV2ItemById can't set a field value.
			const added = await client.graphql<AddProjectItemResponse>(ADD_PROJECT_ITEM_MUTATION, {
				projectId,
				contentId: issue.node_id,
			});
			const itemId = added.addProjectV2ItemById?.item?.id;
			if (!itemId) {
				throw new Error(`addProjectV2ItemById returned no item id for issue #${issue.number}`);
			}
			await client.graphql(MOVE_ITEM_MUTATION, {
				projectId,
				itemId,
				fieldId: statusFieldId,
				optionId,
			});
			logger.debug('pm: created work item', {
				itemId,
				issueNumber: issue.number,
				status: input.status,
			});
			return {
				id: itemId,
				title: issue.title,
				description: issue.body ?? '',
				url: issue.html_url,
				statusId: optionId,
				labels: (issue.labels ?? [])
					.map((l) =>
						typeof l === 'string'
							? { id: l, name: l }
							: { id: String(l.id), name: l.name ?? '', color: l.color ?? undefined },
					)
					.filter((l): l is WorkItemLabel => l.name.length > 0),
			};
		});
	}

	async updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void> {
		// Title/description live on the backing Issue, not the board card — resolve
		// it first (its own scoped run), mirroring addComment's two-step shape.
		const { owner, repo, contentNumber } = await this.resolveItem(id);
		if (!owner || !repo || contentNumber == null) {
			throw new Error(
				`Cannot update item '${id}': it has no backing Issue to update (likely a draft item)`,
			);
		}
		if (patch.title === undefined && patch.description === undefined) return;
		await this.run(async () => {
			await getScopedClient().issues.update({
				owner,
				repo,
				issue_number: contentNumber,
				...(patch.title !== undefined ? { title: patch.title } : {}),
				...(patch.description !== undefined ? { body: patch.description } : {}),
			});
		});
		logger.debug('pm: updated work item', { itemId: id });
	}
}

/**
 * Ensure a label exists in the repo before it's applied to a new issue —
 * `issues.create` errors on an unknown label. Created with GitHub's neutral grey
 * when missing; a concurrent create that already made it (422) is treated as
 * success. Must run inside a scoped-credentials context (its callers do).
 */
async function ensureLabel(owner: string, repo: string, name: string): Promise<void> {
	const client = getScopedClient();
	try {
		await client.issues.getLabel({ owner, repo, name });
		return;
	} catch (err) {
		if (!isHttpStatus(err, 404)) throw err;
	}
	try {
		await client.issues.createLabel({ owner, repo, name, color: DEFAULT_LABEL_COLOR });
	} catch (err) {
		// A parallel create won the race — the label now exists, which is all we need.
		if (!isHttpStatus(err, 422)) throw err;
	}
}

/** Whether an Octokit error carries a specific HTTP status. */
function isHttpStatus(err: unknown, status: number): boolean {
	return typeof err === 'object' && err !== null && (err as { status?: number }).status === status;
}

/**
 * Build the GitHub Projects PM provider for a project. The one construction
 * seam callers (the worker's phase dispatch, the trigger handlers) use, so they
 * depend on the `PMProvider` interface rather than the concrete class.
 */
export function createGitHubProjectsProvider(project: ProjectConfig): PMProvider {
	return new GitHubProjectsPMProvider(project);
}
