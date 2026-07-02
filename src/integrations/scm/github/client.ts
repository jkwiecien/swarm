/**
 * GitHub API client with `AsyncLocalStorage`-scoped credentials — ported from
 * Cascade's `src/github/client.ts`.
 *
 * The token is never a function argument. `withGitHubToken(token, fn)` binds an
 * Octokit instance to the async context for the duration of `fn`, and every GitHub
 * operation pulls the client from that context via `getScopedClient()`. This keeps
 * secrets out of call signatures, stack traces, and logs (ai/CODING_STANDARDS.md
 * "Scope credentials with AsyncLocalStorage") and is what lets the implementer and
 * reviewer personas run concurrently without one leaking into the other's calls.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { Octokit } from '@octokit/rest';

import { logger } from '../../../lib/logger.js';

const clientStorage = new AsyncLocalStorage<Octokit>();

/**
 * Get the Octokit client bound to the current async context. Throws if called
 * outside a `withGitHubToken` scope — an operation running without a token in
 * scope is a bug (a missing wrap), not a recoverable condition.
 */
export function getScopedClient(): Octokit {
	const scoped = clientStorage.getStore();
	if (!scoped) {
		throw new Error(
			'No GitHub client in scope. Wrap the call in withGitHubToken() (or the SCM integration’s withPersonaCredentials()).',
		);
	}
	return scoped;
}

/** Run `fn` with an Octokit client authenticated as `token` bound to the async context. */
export function withGitHubToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
	const scopedClient = new Octokit({ auth: token });
	return clientStorage.run(scopedClient, fn);
}

/**
 * Resolve the GitHub login a token authenticates as, or `null` if the token is
 * absent or the lookup fails. Used to map a persona's token to its bot identity
 * for loop prevention (see `personas.ts`). Failures return `null` rather than
 * throwing so a single bad token doesn't take down persona resolution — the
 * caller decides whether a missing identity is fatal.
 */
export async function getGitHubUserForToken(token: string | null): Promise<string | null> {
	if (!token) return null;
	try {
		const client = new Octokit({ auth: token });
		const { data } = await client.users.getAuthenticated();
		return data.login;
	} catch (err) {
		logger.warn('Failed to resolve GitHub identity for token', { error: String(err) });
		return null;
	}
}
