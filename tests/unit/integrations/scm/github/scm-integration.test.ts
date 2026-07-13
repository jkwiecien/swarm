import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	getPersonaToken: vi.fn(),
	getPersonaTokenOrNull: vi.fn(),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({
	// Pass-through so we can assert the token that would be scoped without a real Octokit.
	withGitHubToken: vi.fn((_token: string, fn: () => Promise<unknown>) => fn()),
	enablePullRequestAutoMerge: vi.fn(),
	getGitHubUserForToken: vi.fn(),
}));

import { getPersonaToken, getPersonaTokenOrNull } from '@/config/provider.js';
import {
	enablePullRequestAutoMerge,
	getGitHubUserForToken,
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
	});
});
