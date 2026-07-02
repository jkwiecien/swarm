import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture Octokit constructor calls so we can assert which token each scope
// authenticates with, and stub the authenticated-user lookup.
const octokitInstances: Array<{
	auth: unknown;
	users: { getAuthenticated: ReturnType<typeof vi.fn> };
}> = [];
const getAuthenticated = vi.fn();

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		auth: unknown;
		users = { getAuthenticated };
		constructor(opts: { auth: unknown }) {
			this.auth = opts.auth;
			octokitInstances.push(this);
		}
	},
}));

import { getGitHubUserForToken, getScopedClient, withGitHubToken } from '@/github/client.js';

describe('github client', () => {
	beforeEach(() => {
		octokitInstances.length = 0;
		getAuthenticated.mockReset();
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
});
