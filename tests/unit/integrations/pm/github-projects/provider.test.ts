import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphql = vi.fn();
const createComment = vi.fn();
const createIssue = vi.fn();
const updateIssue = vi.fn();
const getLabel = vi.fn();
const createLabel = vi.fn();
const addLabels = vi.fn();
const getIssue = vi.fn();
const listComments = vi.fn();
const request = vi.fn();
vi.mock('@/integrations/scm/github/client.js', () => ({
	getScopedClient: () => ({
		graphql,
		request,
		issues: {
			createComment,
			create: createIssue,
			update: updateIssue,
			get: getIssue,
			listComments,
			getLabel,
			createLabel,
			addLabels,
		},
	}),
}));
// Run the credential-scoped fn straight through — token resolution is out of
// scope for the provider's own logic.
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		withPersonaCredentials = <T>(_p: unknown, _persona: unknown, fn: () => Promise<T>) => fn();
	},
}));

import {
	createGitHubProjectsProvider,
	GitHubProjectsPMProvider,
} from '@/integrations/pm/github-projects/provider.js';
import { createMockProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

const ITEM_NODE = {
	id: 'PVTI_x',
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-02T00:00:00Z',
	content: {
		__typename: 'Issue',
		number: 10,
		title: 'Wire triggers',
		body: 'Do the thing.',
		url: 'https://github.com/jkwiecien/swarm/issues/10',
		repository: { nameWithOwner: 'jkwiecien/swarm' },
		labels: { nodes: [{ id: 'L1', name: 'phase-4', color: 'blue' }] },
	},
	fieldValueByName: { name: 'In progress', optionId: '47fc9ee4' },
};

describe('GitHubProjectsPMProvider', () => {
	const provider = new GitHubProjectsPMProvider(PROJECT);

	beforeEach(() => {
		graphql.mockReset();
		createComment.mockReset();
		createIssue.mockReset();
		updateIssue.mockReset();
		getLabel.mockReset();
		createLabel.mockReset();
		addLabels.mockReset();
		getIssue.mockReset();
		listComments.mockReset();
		request.mockReset();
	});

	it('createGitHubProjectsProvider builds the provider', () => {
		expect(createGitHubProjectsProvider(PROJECT)).toBeInstanceOf(GitHubProjectsPMProvider);
	});

	describe('getWorkItem', () => {
		it('maps the GraphQL item to a WorkItem', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });

			const item = await provider.getWorkItem('PVTI_x');

			expect(item).toEqual({
				id: 'PVTI_x',
				title: 'Wire triggers',
				description: 'Do the thing.',
				url: 'https://github.com/jkwiecien/swarm/issues/10',
				status: 'In progress',
				statusId: '47fc9ee4',
				labels: [{ id: 'L1', name: 'phase-4', color: 'blue' }],
				// The node carries no `assignees` at all — an unassigned item is `[]`.
				assignees: [],
				createdAt: '2026-07-01T00:00:00Z',
				updatedAt: '2026-07-02T00:00:00Z',
			});
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('ProjectV2Item'), {
				itemId: 'PVTI_x',
			});
		});

		it('requests the complete label set using first: 100 in the query', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });

			await provider.getWorkItem('PVTI_x');

			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('labels(first: 100)'), {
				itemId: 'PVTI_x',
			});
		});

		it('correctly maps more than 50 labels returned by the GraphQL API', async () => {
			const dummyLabels = Array.from({ length: 55 }, (_, i) => ({
				id: `L_${i}`,
				name: `label-${i}`,
				color: 'grey',
			}));
			graphql.mockResolvedValue({
				node: {
					...ITEM_NODE,
					content: {
						...ITEM_NODE.content,
						labels: { nodes: dummyLabels },
					},
				},
			});

			const item = await provider.getWorkItem('PVTI_x');

			expect(item.labels).toHaveLength(55);
			expect(item.labels[54]).toEqual({ id: 'L_54', name: 'label-54', color: 'grey' });
		});

		it('throws when the item does not resolve', async () => {
			graphql.mockResolvedValue({ node: null });
			await expect(provider.getWorkItem('PVTI_missing')).rejects.toThrow('did not resolve');
		});
	});

	describe('assignees', () => {
		it('declares assignee support', () => {
			expect(provider.supportsAssignees).toBe(true);
		});

		it('maps GitHub logins to provider-neutral assignees', async () => {
			graphql.mockResolvedValue({
				node: {
					...ITEM_NODE,
					content: {
						...ITEM_NODE.content,
						assignees: {
							nodes: [
								{ id: 'U_ada', login: 'ada', name: 'Ada Lovelace' },
								// A GitHub account with no profile name reports null/'' — that's
								// "no display name", not an empty one.
								{ id: 'U_grace', login: 'grace', name: null },
							],
						},
					},
				},
			});

			const item = await provider.getWorkItem('PVTI_x');

			expect(item.assignees).toEqual([
				{ handle: 'ada', displayName: 'Ada Lovelace', providerId: 'U_ada' },
				{ handle: 'grace', displayName: undefined, providerId: 'U_grace' },
			]);
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('assignees(first: 10)'), {
				itemId: 'PVTI_x',
			});
		});

		it('drops a node with no login and carries assignees through listWorkItems', async () => {
			graphql.mockResolvedValue({
				node: {
					items: {
						nodes: [
							{
								...ITEM_NODE,
								content: {
									...ITEM_NODE.content,
									assignees: { nodes: [{ login: 'ada' }, { id: 'U_broken' }] },
								},
							},
						],
					},
				},
			});

			const [item] = await provider.listWorkItems();

			expect(item.assignees).toEqual([
				{ handle: 'ada', displayName: undefined, providerId: undefined },
			]);
		});
	});

	describe('listWorkItems', () => {
		// A second item in a different Status, so the client-side filter has
		// something to exclude.
		const TODO_NODE = {
			...ITEM_NODE,
			id: 'PVTI_y',
			content: { ...ITEM_NODE.content, number: 11, title: 'Later work' },
			fieldValueByName: { name: 'ToDo', optionId: '3121a97d' },
		};

		it('maps every page node to a WorkItem when no filter is given', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE, TODO_NODE] } } });

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x', 'PVTI_y']);
			expect(graphql).toHaveBeenCalledTimes(1);
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('ProjectV2'), {
				projectId: PROJECT.githubProjects.projectId,
				cursor: undefined,
			});
		});

		it('requests the complete label set using first: 100 in the query', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE] } } });

			await provider.listWorkItems();

			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('labels(first: 100)'), {
				projectId: PROJECT.githubProjects.projectId,
				cursor: undefined,
			});
		});

		it('walks every page, following the cursor until hasNextPage is false', async () => {
			graphql
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [ITEM_NODE],
							pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
						},
					},
				})
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [TODO_NODE],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				});

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x', 'PVTI_y']);
			expect(graphql).toHaveBeenCalledTimes(2);
			expect(graphql).toHaveBeenNthCalledWith(1, expect.any(String), {
				projectId: PROJECT.githubProjects.projectId,
				cursor: undefined,
			});
			expect(graphql).toHaveBeenNthCalledWith(2, expect.any(String), {
				projectId: PROJECT.githubProjects.projectId,
				cursor: 'CURSOR_1',
			});
		});

		it('stops paging when hasNextPage is true but no cursor is returned', async () => {
			graphql.mockResolvedValue({
				node: { items: { nodes: [ITEM_NODE], pageInfo: { hasNextPage: true, endCursor: null } } },
			});

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x']);
			expect(graphql).toHaveBeenCalledTimes(1);
		});

		it('stops paging when a page repeats the cursor it was fetched with', async () => {
			// A misbehaving server that keeps claiming another page while handing back
			// the same cursor must not loop forever.
			graphql
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [ITEM_NODE],
							pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
						},
					},
				})
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [TODO_NODE],
							pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
						},
					},
				});

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x', 'PVTI_y']);
			expect(graphql).toHaveBeenCalledTimes(2);
		});

		it('filters client-side by the option ID resolved from the status key', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE, TODO_NODE] } } });

			const items = await provider.listWorkItems({ status: 'inProgress' });

			expect(items.map((i) => i.id)).toEqual(['PVTI_x']);
		});

		it('throws for a requested status with no option mapping (rather than returning all)', async () => {
			// An unmapped status key must not fall through to the no-filter path and
			// return every item — it's a config/logic error, like moveWorkItem's.
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE, TODO_NODE] } } });

			await expect(provider.listWorkItems({ status: 'nonsense' })).rejects.toThrow(
				"status 'nonsense' has no option ID",
			);
			expect(graphql).not.toHaveBeenCalled();
		});

		it('drops null/id-less nodes', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [null, ITEM_NODE, { id: '' }] } } });

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x']);
		});
	});

	describe('moveWorkItem', () => {
		it('writes the mapped option ID to the Status field', async () => {
			graphql.mockResolvedValue({
				updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_x' } },
			});

			await provider.moveWorkItem('PVTI_x', 'inProgress');

			expect(graphql).toHaveBeenCalledWith(
				expect.stringContaining('updateProjectV2ItemFieldValue'),
				{
					projectId: PROJECT.githubProjects.projectId,
					itemId: 'PVTI_x',
					fieldId: PROJECT.githubProjects.statusFieldId,
					optionId: '47fc9ee4',
				},
			);
		});

		it('throws for a status with no option mapping', async () => {
			await expect(provider.moveWorkItem('PVTI_x', 'nonsense')).rejects.toThrow(
				"status 'nonsense' has no option ID",
			);
			expect(graphql).not.toHaveBeenCalled();
		});
	});

	describe('addComment', () => {
		it('posts on the backing Issue and returns the comment ID', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			createComment.mockResolvedValue({ data: { id: 999888 } });

			const id = await provider.addComment('PVTI_x', 'a plan');

			expect(createComment).toHaveBeenCalledWith({
				owner: 'jkwiecien',
				repo: 'swarm',
				issue_number: 10,
				body: 'a plan',
			});
			expect(id).toBe('999888');
		});

		it('throws when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.addComment('PVTI_draft', 'x')).rejects.toThrow('no backing Issue/PR');
			expect(createComment).not.toHaveBeenCalled();
		});
	});

	describe('findComment', () => {
		it('returns comment ID if a comment starts with the given prefix', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			listComments.mockResolvedValue({
				data: [
					{ id: 111, body: 'some unrelated comment' },
					{ id: 222, body: '## 🗺️ Proposed implementation plan\n1. Do the thing' },
				],
			});

			const id = await provider.findComment('PVTI_x', '## 🗺️ Proposed implementation plan');

			expect(listComments).toHaveBeenCalledWith({
				owner: 'jkwiecien',
				repo: 'swarm',
				issue_number: 10,
				per_page: 100,
			});
			expect(id).toBe('222');
		});

		it('returns undefined if no comment starts with the given prefix', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			listComments.mockResolvedValue({
				data: [
					{ id: 111, body: 'some unrelated comment' },
				],
			});

			const id = await provider.findComment('PVTI_x', '## 🗺️ Proposed implementation plan');
			expect(id).toBeUndefined();
		});

		it('returns undefined when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			const id = await provider.findComment('PVTI_draft', '## 🗺️ Proposed implementation plan');
			expect(id).toBeUndefined();
			expect(listComments).not.toHaveBeenCalled();
		});
	});

	describe('createWorkItem', () => {
		it('creates the Issue, adds it to the board, sets its status, and applies labels', async () => {
			getLabel.mockResolvedValue({ data: {} }); // label already exists
			createIssue.mockResolvedValue({
				data: {
					node_id: 'I_new',
					number: 42,
					title: 'Sibling task',
					body: 'Second half',
					html_url: 'https://github.com/jkwiecien/swarm/issues/42',
					labels: [{ id: 1, name: 'swarm:split-child', color: 'ededed' }],
				},
			});
			graphql
				.mockResolvedValueOnce({ addProjectV2ItemById: { item: { id: 'PVTI_new' } } })
				.mockResolvedValueOnce({});

			const created = await provider.createWorkItem({
				title: 'Sibling task',
				description: 'Second half',
				status: 'planning',
				labels: ['swarm:split-child'],
			});

			expect(createIssue).toHaveBeenCalledWith({
				owner: 'jkwiecien',
				repo: 'swarm',
				title: 'Sibling task',
				body: 'Second half',
				labels: ['swarm:split-child'],
			});
			// Added to the board...
			expect(graphql).toHaveBeenNthCalledWith(1, expect.stringContaining('addProjectV2ItemById'), {
				projectId: PROJECT.githubProjects.projectId,
				contentId: 'I_new',
			});
			// ...then placed in Planning (option 61e4505c per the mock config).
			expect(graphql).toHaveBeenNthCalledWith(
				2,
				expect.stringContaining('updateProjectV2ItemFieldValue'),
				{
					projectId: PROJECT.githubProjects.projectId,
					itemId: 'PVTI_new',
					fieldId: PROJECT.githubProjects.statusFieldId,
					optionId: '61e4505c',
				},
			);
			expect(created).toMatchObject({
				id: 'PVTI_new',
				title: 'Sibling task',
				statusId: '61e4505c',
				url: 'https://github.com/jkwiecien/swarm/issues/42',
			});
			expect(created.labels.map((l) => l.name)).toContain('swarm:split-child');
		});

		it('creates a missing label before creating the Issue', async () => {
			getLabel.mockRejectedValue({ status: 404 });
			createLabel.mockResolvedValue({ data: {} });
			createIssue.mockResolvedValue({
				data: { node_id: 'I_new', number: 43, title: 'T', body: '', html_url: 'u', labels: [] },
			});
			graphql
				.mockResolvedValueOnce({ addProjectV2ItemById: { item: { id: 'PVTI_new' } } })
				.mockResolvedValueOnce({});

			await provider.createWorkItem({
				title: 'T',
				description: '',
				status: 'planning',
				labels: ['swarm:split-child'],
			});

			expect(createLabel).toHaveBeenCalledWith(
				expect.objectContaining({ owner: 'jkwiecien', repo: 'swarm', name: 'swarm:split-child' }),
			);
		});

		it('throws for a status with no option mapping without creating anything', async () => {
			await expect(
				provider.createWorkItem({ title: 'T', description: '', status: 'nonsense' }),
			).rejects.toThrow("status 'nonsense' has no option ID");
			expect(createIssue).not.toHaveBeenCalled();
		});
	});

	describe('updateWorkItem', () => {
		it('updates only the fields provided on the backing Issue', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			updateIssue.mockResolvedValue({ data: {} });

			await provider.updateWorkItem('PVTI_x', { title: 'Renamed' });

			expect(updateIssue).toHaveBeenCalledWith({
				owner: 'jkwiecien',
				repo: 'swarm',
				issue_number: 10,
				title: 'Renamed',
			});
		});

		it('is a no-op write when the patch is empty', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			await provider.updateWorkItem('PVTI_x', {});
			expect(updateIssue).not.toHaveBeenCalled();
		});

		it('throws when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.updateWorkItem('PVTI_draft', { title: 'x' })).rejects.toThrow(
				'no backing Issue',
			);
			expect(updateIssue).not.toHaveBeenCalled();
		});
	});

	describe('addLabel', () => {
		it('applies an existing label without recreating it', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			getLabel.mockResolvedValue({ data: {} }); // label already exists
			addLabels.mockResolvedValue({ data: [] });

			await provider.addLabel('PVTI_x', 'planned');

			expect(createLabel).not.toHaveBeenCalled();
			expect(addLabels).toHaveBeenCalledWith({
				owner: 'jkwiecien',
				repo: 'swarm',
				issue_number: 10,
				labels: ['planned'],
			});
		});

		it('creates the label when it does not yet exist, then applies it', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			getLabel.mockRejectedValue({ status: 404 });
			createLabel.mockResolvedValue({ data: {} });
			addLabels.mockResolvedValue({ data: [] });

			await provider.addLabel('PVTI_x', 'planned');

			expect(createLabel).toHaveBeenCalledWith(
				expect.objectContaining({ owner: 'jkwiecien', repo: 'swarm', name: 'planned' }),
			);
			expect(addLabels).toHaveBeenCalledWith(
				expect.objectContaining({ issue_number: 10, labels: ['planned'] }),
			);
		});

		it('throws when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.addLabel('PVTI_draft', 'planned')).rejects.toThrow('no backing Issue');
			expect(addLabels).not.toHaveBeenCalled();
		});
	});

	describe('supportsDependencies', () => {
		it('is true — GitHub Issues models dependencies natively', () => {
			expect(provider.supportsDependencies).toBe(true);
		});
	});

	describe('listBlockers', () => {
		it('merges native "blocked by" relationships with prerequisites mentioned in prose', async () => {
			// resolveItem → the item (issue #10 in jkwiecien/swarm, body has no refs).
			graphql.mockResolvedValue({ node: ITEM_NODE });
			// Native blocked-by: issue #5, still open.
			request.mockResolvedValue({
				data: [
					{
						id: 500,
						number: 5,
						title: 'Prereq',
						html_url: 'https://github.com/jkwiecien/swarm/issues/5',
						state: 'open',
					},
				],
			});
			// A comment names a prose dependency on #7.
			listComments.mockResolvedValue({ data: [{ body: 'This depends on #7 landing first.' }] });
			getIssue.mockResolvedValue({
				data: {
					number: 7,
					title: 'Seven',
					html_url: 'https://github.com/jkwiecien/swarm/issues/7',
					state: 'closed',
				},
			});

			const blockers = await provider.listBlockers('PVTI_x');

			expect(request).toHaveBeenCalledWith(
				'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
				expect.objectContaining({ owner: 'jkwiecien', repo: 'swarm', issue_number: 10 }),
			);
			expect(blockers).toEqual([
				expect.objectContaining({ reference: '#5', open: true, source: 'dependency' }),
				expect.objectContaining({ reference: '#7', open: false, source: 'mention' }),
			]);
		});

		it('treats a missing issue-dependencies API (404) as no native blockers', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			request.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
			listComments.mockResolvedValue({ data: [] });

			await expect(provider.listBlockers('PVTI_x')).resolves.toEqual([]);
		});

		it('returns [] for a draft item with no backing Issue', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.listBlockers('PVTI_draft')).resolves.toEqual([]);
			expect(request).not.toHaveBeenCalled();
		});
	});

	describe('addBlockedBy', () => {
		it('POSTs the blocker by its numeric database id to the dependencies API', async () => {
			graphql.mockImplementation(async (_q: string, vars: { itemId: string }) => ({
				node: {
					...ITEM_NODE,
					id: vars.itemId,
					content: {
						...ITEM_NODE.content,
						number: vars.itemId === 'PVTI_blocker' ? 5 : 20,
					},
				},
			}));
			getIssue.mockResolvedValue({ data: { id: 9999, number: 5 } });
			request.mockResolvedValue({ data: {} });

			await provider.addBlockedBy('PVTI_target', 'PVTI_blocker');

			expect(request).toHaveBeenCalledWith(
				'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
				expect.objectContaining({
					owner: 'jkwiecien',
					repo: 'swarm',
					issue_number: 20,
					issue_id: 9999,
				}),
			);
		});

		it('is idempotent — swallows a 422 (dependency already recorded)', async () => {
			graphql.mockImplementation(async (_q: string, vars: { itemId: string }) => ({
				node: {
					...ITEM_NODE,
					id: vars.itemId,
					content: { ...ITEM_NODE.content, number: vars.itemId === 'PVTI_blocker' ? 5 : 20 },
				},
			}));
			getIssue.mockResolvedValue({ data: { id: 9999, number: 5 } });
			request.mockRejectedValue(Object.assign(new Error('Unprocessable'), { status: 422 }));

			await expect(provider.addBlockedBy('PVTI_target', 'PVTI_blocker')).resolves.toBeUndefined();
		});
	});
});
