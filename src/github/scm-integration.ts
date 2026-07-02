/**
 * GitHubSCMIntegration — GitHub SCM credential resolution, ported from Cascade's
 * `src/github/scm-integration.ts`.
 *
 * The one job of this class is to run a block of GitHub operations under the
 * correct persona's credentials. Callers hand it a project + persona and a
 * function; it resolves that persona's token and binds it to the async context
 * (via `withGitHubToken`) for the duration of the call. Because resolution
 * happens per invocation, a single pipeline can review as the reviewer and push
 * fixes as the implementer without either token ever appearing in a signature
 * (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 */

import { getPersonaToken, getPersonaTokenOrNull } from '../config/provider.js';
import type { ProjectConfig } from '../config/schema.js';
import { withGitHubToken } from './client.js';
import type { GitHubPersona } from './personas.js';

export class GitHubSCMIntegration {
	readonly type = 'github' as const;
	readonly category = 'scm' as const;

	/**
	 * Whether GitHub SCM is usable for a project — true if at least one persona
	 * token is configured. Some flows only need one persona, so this is
	 * deliberately an OR, not an AND.
	 */
	async hasIntegration(project: ProjectConfig): Promise<boolean> {
		const [implementer, reviewer] = await Promise.all([
			getPersonaTokenOrNull(project, 'implementer'),
			getPersonaTokenOrNull(project, 'reviewer'),
		]);
		return implementer !== null || reviewer !== null;
	}

	/** Whether a specific persona's token is configured for a project. */
	async hasPersonaToken(project: ProjectConfig, persona: GitHubPersona): Promise<boolean> {
		const token = await getPersonaTokenOrNull(project, persona);
		return token !== null;
	}

	/**
	 * Resolve `persona`'s token for `project` and run `fn` within that GitHub
	 * credential scope. Every GitHub operation inside `fn` — via
	 * `getScopedClient()` — authenticates as that persona. Throws (before running
	 * `fn`) if the persona's token isn't configured.
	 */
	async withPersonaCredentials<T>(
		project: ProjectConfig,
		persona: GitHubPersona,
		fn: () => Promise<T>,
	): Promise<T> {
		const token = await getPersonaToken(project, persona);
		return withGitHubToken(token, fn);
	}

	/**
	 * Convenience wrapper for the common case: run `fn` as the implementer, the
	 * persona behind most SCM writes (opening PRs, pushing, commenting).
	 */
	async withCredentials<T>(project: ProjectConfig, fn: () => Promise<T>): Promise<T> {
		return this.withPersonaCredentials(project, 'implementer', fn);
	}
}
