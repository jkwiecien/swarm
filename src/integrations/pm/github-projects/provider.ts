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
import { dedupeBlockers, findDependencyReferences } from '../../../pm/dependencies.js';
import type {
	CreateWorkItemInput,
	PMProvider,
	PMType,
	UpdateWorkItemPatch,
	WorkItem,
	WorkItemAssignee,
	WorkItemBlocker,
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
	assignees?: { nodes?: Array<{ id?: string; login?: string; name?: string | null }> };
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

/**
 * Read one item, its Status option, and its backing Issue/PR in one round-trip.
 *
 * The label page size is deliberately generous: `WorkItem.labels` now drives the
 * automation gate (issue #131), so a label truncated off the end of the page
 * would read as "not opted in" and silently halt the pipeline on a busy issue.
 */
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
						labels(first: 100) { nodes { id name color } }
						assignees(first: 10) { nodes { id login name } }
					}
					... on PullRequest {
						number title body url
						repository { nameWithOwner }
						labels(first: 100) { nodes { id name color } }
						assignees(first: 10) { nodes { id login name } }
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
								labels(first: 100) { nodes { id name color } }
								assignees(first: 10) { nodes { id login name } }
							}
							... on PullRequest {
								number title body url
								repository { nameWithOwner }
								labels(first: 100) { nodes { id name color } }
								assignees(first: 10) { nodes { id login name } }
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

/**
 * Map the issue/PR's assignees to the provider-neutral shape. GitHub's `login`
 * vocabulary stops here — the rest of SWARM speaks `WorkItemAssignee.handle`
 * (ai/RULES.md §2). A `name` GitHub leaves unset comes back as `null`/`''`,
 * which is "no display name" rather than an empty one.
 */
function mapAssignees(content: ContentNode | null | undefined): WorkItemAssignee[] {
	const nodes = content?.assignees?.nodes ?? [];
	return nodes
		.filter((n): n is { id?: string; login: string; name?: string | null } => !!n?.login)
		.map((n) => ({ handle: n.login, displayName: n.name || undefined, providerId: n.id }));
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
		assignees: mapAssignees(content),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
	return { workItem, owner, repo, contentNumber: content?.number };
}

export class GitHubProjectsPMProvider implements PMProvider {
	readonly type: PMType = 'github-projects';

	// GitHub Issues models cross-issue dependencies natively (the issue-dependencies
	// REST API — docs/github-projects-v2-api.md), so this provider supports the
	// blocked-by capability. A future Bitbucket/GitLab provider sets this to `false`
	// if it can't, and callers fall back to the human-readable comment guard.
	readonly supportsDependencies = true;

	// GitHub Issues/PRs carry assignees natively, so every item this adapter maps
	// reports them (`mapAssignees`). A provider without the concept sets this
	// `false` and every item stays unassigned.
	readonly supportsAssignees = true;

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
				// A freshly created issue is unassigned — SWARM never assigns on create.
				assignees: [],
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

	async addLabel(id: string, name: string): Promise<void> {
		// Labels live on the backing Issue, not the board card — resolve it first
		// (its own scoped run), mirroring addComment/updateWorkItem's two-step shape.
		const { owner, repo, contentNumber } = await this.resolveItem(id);
		if (!owner || !repo || contentNumber == null) {
			throw new Error(
				`Cannot label item '${id}': it has no backing Issue to label (likely a draft item)`,
			);
		}
		await this.run(async () => {
			const client = getScopedClient();
			// Create the label if missing (reusing the same helper createWorkItem uses),
			// then apply it. issues.addLabels is additive and idempotent — re-adding an
			// already-present label neither duplicates it nor errors.
			await ensureLabel(owner, repo, name);
			await client.issues.addLabels({ owner, repo, issue_number: contentNumber, labels: [name] });
		});
		logger.debug('pm: applied label', { itemId: id, label: name });
	}

	async listBlockers(id: string): Promise<WorkItemBlocker[]> {
		const { workItem, owner, repo, contentNumber } = await this.resolveItem(id);
		// A draft item (no backing Issue) can carry no dependencies — nothing to gate on.
		if (!owner || !repo || contentNumber == null) return [];
		return this.run(async () => {
			// Two sources: the native "blocked by" relationships, plus prerequisites the
			// item names in prose (its own description + comments). Deduped by URL so a
			// dependency that is both linked and mentioned appears once.
			const [native, mentioned] = await Promise.all([
				this.fetchNativeBlockers(owner, repo, contentNumber),
				this.fetchMentionedBlockers(owner, repo, contentNumber, workItem.description),
			]);
			return dedupeBlockers([...native, ...mentioned]);
		});
	}

	async addBlockedBy(id: string, blockerId: string): Promise<void> {
		const [target, blocker] = await Promise.all([
			this.resolveItem(id),
			this.resolveItem(blockerId),
		]);
		if (!target.owner || !target.repo || target.contentNumber == null) {
			throw new Error(`Cannot add dependency to item '${id}': it has no backing Issue`);
		}
		if (!blocker.owner || !blocker.repo || blocker.contentNumber == null) {
			throw new Error(`Cannot block item '${id}': blocker '${blockerId}' has no backing Issue`);
		}
		await this.run(async () => {
			const client = getScopedClient();
			// The dependencies API keys the blocker by its numeric database id, not its
			// number, so resolve the blocking issue once to read `id`.
			const { data: blockerIssue } = await client.issues.get({
				owner: blocker.owner as string,
				repo: blocker.repo as string,
				issue_number: blocker.contentNumber as number,
			});
			try {
				await client.request(
					'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
					{
						owner: target.owner as string,
						repo: target.repo as string,
						issue_number: target.contentNumber as number,
						issue_id: blockerIssue.id,
					},
				);
				logger.debug('pm: linked blocked-by dependency', {
					itemId: id,
					blockerId,
					blockerIssue: blocker.contentNumber,
				});
			} catch (err) {
				// Idempotent: an already-recorded dependency comes back 422 — treat as success.
				if (isHttpStatus(err, 422)) return;
				throw err;
			}
		});
	}

	/**
	 * The item's native "blocked by" prerequisites, via the GitHub issue-dependencies
	 * REST API. A repo/plan without the feature answers 404/410 — treated as "no
	 * dependencies" (best-effort) rather than failing the caller's gate.
	 */
	private async fetchNativeBlockers(
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<WorkItemBlocker[]> {
		try {
			const { data } = await getScopedClient().request(
				'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
				{ owner, repo, issue_number: issueNumber, per_page: 100 },
			);
			const issues = (data ?? []) as DependencyIssue[];
			return issues
				.filter((i): i is DependencyIssue & { number: number } => typeof i.number === 'number')
				.map((i) => toBlocker(i, 'dependency'));
		} catch (err) {
			if (isHttpStatus(err, 404) || isHttpStatus(err, 410)) {
				logger.debug('pm: issue-dependencies API unavailable; treating as no native blockers', {
					owner,
					repo,
					issueNumber,
				});
				return [];
			}
			throw err;
		}
	}

	/**
	 * Prerequisites the item *names in prose* — its own description and comments —
	 * that aren't native relationships. Provider-neutral reference extraction
	 * (`findDependencyReferences`); this adapter resolves each referenced issue's
	 * live open/closed state. A reference that doesn't resolve is skipped (a typo'd
	 * or cross-repo number is not a gate).
	 */
	private async fetchMentionedBlockers(
		owner: string,
		repo: string,
		issueNumber: number,
		description: string,
	): Promise<WorkItemBlocker[]> {
		const client = getScopedClient();
		// Only the first page (100 comments) is scanned — a prose dependency buried
		// past comment #100 is missed, but the native `blocked by` relationship and
		// the item's own description remain the durable guards, so this best-effort
		// scan of the most likely places (description + early discussion) is enough
		// without paginating a long thread on every gate check.
		const { data: comments } = await client.issues.listComments({
			owner,
			repo,
			issue_number: issueNumber,
			per_page: 100,
		});
		const prose = [description, ...comments.map((c) => c.body ?? '')].join('\n');
		const refs = findDependencyReferences(prose).filter((n) => n !== String(issueNumber));
		const resolved = await Promise.all(
			refs.map(async (ref): Promise<WorkItemBlocker | undefined> => {
				try {
					const { data: issue } = await client.issues.get({
						owner,
						repo,
						issue_number: Number(ref),
					});
					return toBlocker(issue, 'mention');
				} catch (err) {
					if (isHttpStatus(err, 404)) return undefined;
					throw err;
				}
			}),
		);
		return resolved.filter((b): b is WorkItemBlocker => b !== undefined);
	}
}

/** The subset of a GitHub Issue the dependency endpoints return that we map from. */
interface DependencyIssue {
	id?: number;
	number?: number;
	title?: string | null;
	html_url?: string;
	state?: string;
}

/** Map a GitHub issue (native dependency or resolved mention) to a provider-neutral blocker. */
function toBlocker(issue: DependencyIssue, source: WorkItemBlocker['source']): WorkItemBlocker {
	return {
		reference: issue.number != null ? `#${issue.number}` : (issue.html_url ?? '?'),
		url: issue.html_url ?? '',
		title: issue.title ?? '',
		open: issue.state !== 'closed',
		source,
	};
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
