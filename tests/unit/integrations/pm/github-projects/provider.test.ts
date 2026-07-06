import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphql = vi.fn();
const createComment = vi.fn();
vi.mock('@/integrations/scm/github/client.js', () => ({
	getScopedClient: () => ({ graphql, issues: { createComment } }),
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
				createdAt: '2026-07-01T00:00:00Z',
				updatedAt: '2026-07-02T00:00:00Z',
			});
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('ProjectV2Item'), {
				itemId: 'PVTI_x',
			});
		});

		it('throws when the item does not resolve', async () => {
			graphql.mockResolvedValue({ node: null });
			await expect(provider.getWorkItem('PVTI_missing')).rejects.toThrow('did not resolve');
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
});
