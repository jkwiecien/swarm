import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/scm/github/client.js', () => ({
	getGitHubUserForToken: vi.fn(),
}));

import { scmRouter } from '@/api/routers/scm.js';
import { getGitHubUserForToken } from '@/integrations/scm/github/client.js';

describe('scmRouter', () => {
	const caller = scmRouter.createCaller({});

	beforeEach(() => {
		vi.mocked(getGitHubUserForToken).mockReset();
	});

	describe('verifyGithubToken', () => {
		it('returns the resolved login when the token is valid', async () => {
			vi.mocked(getGitHubUserForToken).mockResolvedValue('octocat');

			const result = await caller.verifyGithubToken({ token: 'ghp_valid' });

			expect(result).toEqual({ valid: true, login: 'octocat' });
			expect(getGitHubUserForToken).toHaveBeenCalledWith('ghp_valid');
		});

		it('returns a not-valid result when the token does not resolve', async () => {
			vi.mocked(getGitHubUserForToken).mockResolvedValue(null);

			const result = await caller.verifyGithubToken({ token: 'ghp_bad' });

			expect(result).toEqual({ valid: false });
		});

		it('rejects an empty token before calling GitHub', async () => {
			await expect(caller.verifyGithubToken({ token: '' })).rejects.toThrow();
			expect(getGitHubUserForToken).not.toHaveBeenCalled();
		});
	});
});
