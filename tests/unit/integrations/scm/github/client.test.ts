import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture Octokit constructor calls so we can assert which token each scope
// authenticates with, and stub the authenticated-user lookup.
const octokitInstances: Array<{
	auth: unknown;
	users: { getAuthenticated: ReturnType<typeof vi.fn> };
}> = [];
const getAuthenticated = vi.fn();
// Shared Actions-API endpoint stubs + paginate: `getCheckSuiteStatus` passes
// each endpoint reference to `paginate`, so paginate switches on identity.
const listWorkflowRunsForRepo = vi.fn();
const listJobsForWorkflowRun = vi.fn();
const paginate = vi.fn();

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		auth: unknown;
		users = { getAuthenticated };
		actions = { listWorkflowRunsForRepo, listJobsForWorkflowRun };
		paginate = paginate;
		constructor(opts: { auth: unknown }) {
			this.auth = opts.auth;
			octokitInstances.push(this);
		}
	},
}));

import {
	getCheckSuiteStatus,
	getGitHubUserForToken,
	getScopedClient,
	withGitHubToken,
} from '@/integrations/scm/github/client.js';

describe('github client', () => {
	beforeEach(() => {
		octokitInstances.length = 0;
		getAuthenticated.mockReset();
		listWorkflowRunsForRepo.mockReset();
		listJobsForWorkflowRun.mockReset();
		paginate.mockReset();
	});

	describe('getScopedClient', () => {
		it('throws when called outside a withGitHubToken scope', () => {
			expect(() => getScopedClient()).toThrow(/No GitHub client in scope/);
		});
	});

	describe('withGitHubToken', () => {
		it('binds an Octokit authenticated with the given token to the async scope', async () => {
			const seen = await withGitHubToken('tok-abc', async () => getScopedClient());
			expect(octokitInstances).toHaveLength(1);
			expect(octokitInstances[0].auth).toBe('tok-abc');
			expect(seen).toBe(octokitInstances[0]);
		});

		it('returns the value produced by fn', async () => {
			const result = await withGitHubToken('tok', async () => 42);
			expect(result).toBe(42);
		});

		it('does not leak the client past the scope', async () => {
			await withGitHubToken('tok', async () => getScopedClient());
			expect(() => getScopedClient()).toThrow(/No GitHub client in scope/);
		});

		it('isolates concurrent scopes — each sees its own token', async () => {
			const [a, b] = await Promise.all([
				withGitHubToken('tok-a', async () => getScopedClient().auth),
				withGitHubToken('tok-b', async () => getScopedClient().auth),
			]);
			expect(a).toBe('tok-a');
			expect(b).toBe('tok-b');
		});
	});

	describe('getGitHubUserForToken', () => {
		it('returns null for a null token without calling GitHub', async () => {
			expect(await getGitHubUserForToken(null)).toBeNull();
			expect(getAuthenticated).not.toHaveBeenCalled();
		});

		it('returns the authenticated login for a valid token', async () => {
			getAuthenticated.mockResolvedValue({ data: { login: 'swarm-impl' } });
			expect(await getGitHubUserForToken('tok')).toBe('swarm-impl');
		});

		it('returns null (not throw) when the lookup fails', async () => {
			getAuthenticated.mockRejectedValue(new Error('401'));
			expect(await getGitHubUserForToken('bad-tok')).toBeNull();
		});
	});

	describe('getCheckSuiteStatus', () => {
		it('flattens workflow-run jobs into check runs, deduping stale reruns per workflow', async () => {
			// Two runs of workflow 100 (newest-first: run 1 kept, run 2 the stale
			// rerun dropped) plus one run of workflow 200.
			paginate.mockImplementation(async (endpoint: unknown, params: { run_id?: number }) => {
				if (endpoint === listWorkflowRunsForRepo) {
					return [
						{ id: 1, workflow_id: 100 },
						{ id: 2, workflow_id: 100 },
						{ id: 3, workflow_id: 200 },
					];
				}
				const jobsByRun: Record<number, unknown[]> = {
					1: [{ name: 'build', status: 'completed', conclusion: 'success' }],
					2: [{ name: 'build', status: 'completed', conclusion: 'failure' }],
					3: [{ name: 'test', status: 'in_progress', conclusion: null }],
				};
				return jobsByRun[params.run_id ?? -1] ?? [];
			});

			const result = await withGitHubToken('tok', () =>
				getCheckSuiteStatus('jkwiecien', 'swarm', 'cafe'),
			);

			expect(result).toEqual({
				totalCount: 2,
				checkRuns: [
					{ name: 'build', status: 'completed', conclusion: 'success' },
					{ name: 'test', status: 'in_progress', conclusion: null },
				],
			});
			// The stale rerun (run 2) was never queried — proving the workflow-id dedupe.
			expect(paginate).not.toHaveBeenCalledWith(
				listJobsForWorkflowRun,
				expect.objectContaining({ run_id: 2 }),
			);
		});

		it('returns an empty aggregate when the ref has no workflow runs', async () => {
			paginate.mockResolvedValue([]);
			const result = await withGitHubToken('tok', () =>
				getCheckSuiteStatus('jkwiecien', 'swarm', 'deadbeef'),
			);
			expect(result).toEqual({ totalCount: 0, checkRuns: [] });
		});
	});
});
