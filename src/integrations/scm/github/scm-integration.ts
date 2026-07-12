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

import { getPersonaToken, getPersonaTokenOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import {
	type ConflictCandidatePullRequest,
	getPullRequestTitle,
	listOpenPullRequestsForBase,
	mergePullRequest,
	type PullRequestMergeResult,
	postIssueComment,
	withGitHubToken,
} from './client.js';
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

	/**
	 * Post a top-level comment on a pull request as `persona`, returning the new
	 * comment's id. The PR-driven phases (review / respond-to-*) normally comment
	 * from *inside* the agent run via `gh`; this is the out-of-band path for the
	 * worker's stalled-job safety net, where the run was reclaimed before it could
	 * comment itself and the PM provider has no PR → comment mapping. Defaults to
	 * the implementer (the PR's author, whose token is always configured for a
	 * project that opens PRs); a comment triggers no pipeline phase, so the persona
	 * choice is immaterial to loop prevention.
	 */
	async commentOnPullRequest(
		project: ProjectConfig,
		prNumber: number,
		body: string,
		persona: GitHubPersona = 'implementer',
	): Promise<number> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () =>
			postIssueComment(owner, repo, prNumber, body),
		);
	}

	/**
	 * Resolve a PR's title for a run-history row (the worker's `tryCreateRun`).
	 * Reads under the implementer persona (the PR's author, whose token is always
	 * configured for a project that opens PRs); reading a title triggers no
	 * pipeline phase, so the persona choice is immaterial to loop prevention.
	 */
	async getPullRequestTitle(
		project: ProjectConfig,
		prNumber: number,
		persona: GitHubPersona = 'implementer',
	): Promise<string | null> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () =>
			getPullRequestTitle(owner, repo, prNumber),
		);
	}

	/** Attempt a normal merge as the implementer after a successful review response. */
	async mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
	): Promise<PullRequestMergeResult> {
		const [owner, repo] = project.repo.split('/');
		return this.withCredentials(project, () => mergePullRequest(owner, repo, prNumber));
	}

	/** Provider seam for conflict detection after a base branch advances. */
	async listConflictCandidates(
		project: ProjectConfig,
		baseBranch: string,
	): Promise<ConflictCandidatePullRequest[]> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, 'implementer', () =>
			listOpenPullRequestsForBase(owner, repo, baseBranch),
		);
	}
}
