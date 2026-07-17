import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const { mockExecFile } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	execFile: mockExecFile,
}));

vi.mock('@/config/provider.js', () => ({
	getPersonaToken: vi.fn(),
	getPersonaTokenOrNull: vi.fn(),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({
	// Pass-through so we can assert the token that would be scoped without a real Octokit.
	withGitHubToken: vi.fn((_token: string, fn: () => Promise<unknown>) => fn()),
	enablePullRequestAutoMerge: vi.fn(),
	getGitHubUserForToken: vi.fn(),
	getPullRequestMergeState: vi.fn(),
	mergePullRequestDirect: vi.fn(),
}));

import { getPersonaToken, getPersonaTokenOrNull } from '@/config/provider.js';
import {
	enablePullRequestAutoMerge,
	getGitHubUserForToken,
	getPullRequestMergeState,
	mergePullRequestDirect,
	withGitHubToken,
} from '@/integrations/scm/github/client.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';

const project = createMockProjectConfig();

describe('GitHubSCMIntegration', () => {
	const scm = new GitHubSCMIntegration();

	beforeEach(() => {
		vi.mocked(getPersonaToken).mockReset();
		vi.mocked(getPersonaTokenOrNull).mockReset();
		vi.mocked(withGitHubToken).mockClear();
		mockExecFile.mockImplementation(
			(_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) =>
				callback(null, '', ''),
		);
	});

	describe('hasIntegration', () => {
		it('is true when only the implementer token is configured', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'tok' : null,
			);
			expect(await scm.hasIntegration(project)).toBe(true);
		});

		it('is true when only the reviewer token is configured', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'reviewer' ? 'tok' : null,
			);
			expect(await scm.hasIntegration(project)).toBe(true);
		});

		it('is false when neither token is configured', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue(null);
			expect(await scm.hasIntegration(project)).toBe(false);
		});
	});

	describe('hasPersonaToken', () => {
		it('reflects whether the specific persona token exists', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue('tok');
			expect(await scm.hasPersonaToken(project, 'reviewer')).toBe(true);
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue(null);
			expect(await scm.hasPersonaToken(project, 'reviewer')).toBe(false);
		});
	});

	describe('withPersonaCredentials', () => {
		it("scopes the persona's token and runs fn within it", async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-rev');
			const result = await scm.withPersonaCredentials(project, 'reviewer', async () => 'done');

			expect(getPersonaToken).toHaveBeenCalledWith(project, 'reviewer');
			expect(withGitHubToken).toHaveBeenCalledWith('tok-rev', expect.any(Function));
			expect(result).toBe('done');
		});

		it('propagates the throw when the persona token is missing', async () => {
			vi.mocked(getPersonaToken).mockRejectedValue(new Error('no reviewer token'));
			await expect(
				scm.withPersonaCredentials(project, 'reviewer', async () => 'never'),
			).rejects.toThrow(/no reviewer token/);
			expect(withGitHubToken).not.toHaveBeenCalled();
		});
	});

	describe('withCredentials', () => {
		it('defaults to the implementer persona', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			await scm.withCredentials(project, async () => undefined);
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});
	});

	describe('enablePullRequestAutoMerge', () => {
		it('enables auto-merge under the implementer credentials', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(enablePullRequestAutoMerge).mockResolvedValue({
				enabled: true,
				message: 'auto-merge enabled',
			});

			await expect(scm.enablePullRequestAutoMerge(project, 42)).resolves.toEqual({
				enabled: true,
				message: 'auto-merge enabled',
			});
			expect(enablePullRequestAutoMerge).toHaveBeenCalledWith('jkwiecien', 'swarm', 42);
		});
	});

	describe('mergePullRequest (issue #253)', () => {
		beforeEach(() => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getPullRequestMergeState).mockReset();
			vi.mocked(mergePullRequestDirect).mockReset();
			vi.mocked(enablePullRequestAutoMerge).mockReset();
		});

		it('runs under the implementer credentials', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: true,
				state: 'closed',
				draft: false,
				headSha: 'reviewed-head',
			});
			await scm.mergePullRequest(project, 42);
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});

		it('reports merged idempotently when the PR is already merged, without arming anything', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: true,
				state: 'closed',
				draft: false,
				headSha: 'reviewed-head',
			});

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'merged',
				message: 'pull request already merged',
			});
			expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is not-ready for a draft pull request, without arming anything', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: true,
				headSha: 'reviewed-head',
			});

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'not-ready',
				message: 'pull request is still a draft',
			});
			expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is not-ready for a closed, unmerged pull request', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'closed',
				draft: false,
				headSha: 'reviewed-head',
			});

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'not-ready',
				message: 'pull request is closed',
			});
			expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is provider-error when the initial PR lookup fails', async () => {
			vi.mocked(getPullRequestMergeState).mockRejectedValue(new Error('502 Bad Gateway'));

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'provider-error',
				message: '502 Bad Gateway',
			});
			expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
		});

		it('prefers GitHub auto-merge and never calls the direct endpoint when it succeeds', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockResolvedValue({
				enabled: true,
				message: 'GitHub auto-merge enabled',
			});

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'not-ready',
				message: 'GitHub auto-merge enabled; waiting for required checks and reviews',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('falls back to a direct merge once GitHub reports auto-merge unavailable', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(
				new Error('Auto-merge is not allowed for this repository'),
			);
			vi.mocked(mergePullRequestDirect).mockResolvedValue({
				merged: true,
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'merged',
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});
			expect(mergePullRequestDirect).toHaveBeenCalledWith(
				'jkwiecien',
				'swarm',
				42,
				'reviewed-head',
			);
		});

		it('does not eagerly fall back to a direct merge for an unrelated auto-merge failure', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(new Error('502 Bad Gateway'));

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'provider-error',
				message: '502 Bad Gateway',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is not-ready when the direct merge reports the PR is not currently mergeable', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(
				new Error('Auto-merge is not allowed for this repository'),
			);
			vi.mocked(mergePullRequestDirect).mockResolvedValue({
				merged: false,
				message: 'At least 1 approving review is required',
			});

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'not-ready',
				message: 'At least 1 approving review is required',
			});
		});

		it('is not-ready when the direct merge endpoint responds 405 (unmet checks/reviews/conflicts)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(
				new Error('Auto-merge is not allowed for this repository'),
			);
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Pull Request is not mergeable'), { status: 405 }),
			);

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'not-ready',
				message: 'Pull Request is not mergeable',
			});
		});

		it('is not-ready when the direct merge endpoint responds 409 (head branch modified)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(
				new Error('Auto-merge is not allowed for this repository'),
			);
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Head branch was modified. Review and try the merge again.'), {
					status: 409,
				}),
			);

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'not-ready',
				message: 'Head branch was modified. Review and try the merge again.',
			});
		});

		it('is policy-blocked when the direct merge endpoint responds 403 for a merge-queue restriction', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(
				new Error('Auto-merge is not allowed for this repository'),
			);
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(
					new Error('Changes must be made through a pull request using a merge queue'),
					{
						status: 403,
					},
				),
			);

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'policy-blocked',
				message: 'Changes must be made through a pull request using a merge queue',
			});
		});

		it('is policy-blocked for a plain 403 branch-protection/permission refusal', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(
				new Error('Auto-merge is not allowed for this repository'),
			);
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Protected branch update failed'), { status: 403 }),
			);

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'policy-blocked',
				message: 'Protected branch update failed',
			});
		});

		it('is provider-error for an unexpected direct-merge failure (e.g. 500 or network)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
			});
			vi.mocked(enablePullRequestAutoMerge).mockRejectedValue(
				new Error('Auto-merge is not allowed for this repository'),
			);
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Internal Server Error'), { status: 500 }),
			);

			await expect(scm.mergePullRequest(project, 42)).resolves.toEqual({
				status: 'provider-error',
				message: 'Internal Server Error',
			});
		});
	});

	describe('deliveryProvider', () => {
		it('resolves deterministic commit identity from the selected persona token', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-implementer');
			const delivery = await scm.deliveryProvider(project, 'implementer');
			expect(delivery.commitIdentity).toEqual({
				name: 'swarm-implementer',
				email: 'swarm-implementer@users.noreply.github.com',
			});
		});

		it('bypasses interactive git hooks when pushing a worker-owned delivery', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-implementer');
			const delivery = await scm.deliveryProvider(project, 'implementer');

			await delivery.pushBranch('/worktree', 'issue-241', 'abc1234');

			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				[
					'push',
					'--no-verify',
					'https://github.com/jkwiecien/swarm.git',
					'abc1234:refs/heads/issue-241',
				],
				expect.objectContaining({ cwd: '/worktree' }),
				expect.any(Function),
			);
		});
	});
});
