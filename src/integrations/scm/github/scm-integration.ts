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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPersonaToken, getPersonaTokenOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import type { ScmDeliveryProvider } from '../../../scm/delivery.js';
import type { MergePullRequestOutcome } from '../../../scm/merge.js';
import {
	type ConflictCandidatePullRequest,
	createPullRequest,
	enablePullRequestAutoMerge,
	findOpenPullRequest,
	getGitHubUserForToken,
	getPullRequestMergeState,
	getPullRequestTitle,
	listOpenPullRequestsForBase,
	mergePullRequestDirect,
	type PullRequestAutoMergeResult,
	postIdempotentPullRequestComment,
	postIssueComment,
	submitPullRequestReview,
	withGitHubToken,
} from './client.js';
import type { GitHubPersona } from './personas.js';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Octokit's `RequestError#status`, if `error` carries one. */
function errorStatus(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}

/**
 * Whether a failed `enablePullRequestAutoMerge` call means "this repository
 * doesn't support auto-merge" (GitHub's GraphQL mutation error when the
 * repository's "Allow auto-merge" setting is off) rather than a transport,
 * auth, or rate-limit failure. Only this recognized case falls back to a
 * direct merge attempt — every other GraphQL failure is a `provider-error`
 * (issue #253: "do not turn unrelated ... failures into an eager direct
 * merge").
 */
function isAutoMergeUnavailable(error: unknown): boolean {
	return /auto-merge is not allowed|auto-merge is not enabled/i.test(errorMessage(error));
}

/**
 * Classify a thrown Octokit error from the direct-merge REST endpoint into the
 * provider-neutral outcome. GitHub's REST merge endpoint responds 405 for a
 * PR that isn't currently mergeable (pending/failing checks, missing
 * approvals, conflicts) and 409 for a race on the expected head — both
 * transient, so `not-ready`. A 403 means the repository's own rules refuse the
 * merge outright: `policy-blocked`, including a merge-queue requirement.
 * Anything else (401, 404, 5xx, network failure) is an unexpected
 * `provider-error`.
 */
function classifyDirectMergeError(error: unknown): MergePullRequestOutcome {
	const message = errorMessage(error);
	const status = errorStatus(error);
	if (status === 405 || status === 409) return { status: 'not-ready', message };
	if (status === 403) return { status: 'policy-blocked', message };
	return { status: 'provider-error', message };
}

/** The credential-scoped body of {@link GitHubSCMIntegration.mergePullRequest}. */
async function mergeReadyPullRequest(
	owner: string,
	repo: string,
	prNumber: number,
): Promise<MergePullRequestOutcome> {
	let state: Awaited<ReturnType<typeof getPullRequestMergeState>>;
	try {
		state = await getPullRequestMergeState(owner, repo, prNumber);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (state.merged) return { status: 'merged', message: 'pull request already merged' };
	if (state.draft) return { status: 'not-ready', message: 'pull request is still a draft' };
	if (state.state !== 'open')
		return { status: 'not-ready', message: `pull request is ${state.state}` };

	try {
		const armed = await enablePullRequestAutoMerge(owner, repo, prNumber);
		return {
			status: 'not-ready',
			message: armed.enabled
				? 'GitHub auto-merge enabled; waiting for required checks and reviews'
				: armed.message,
		};
	} catch (error) {
		if (!isAutoMergeUnavailable(error)) {
			return { status: 'provider-error', message: errorMessage(error) };
		}
	}

	try {
		const merge = await mergePullRequestDirect(owner, repo, prNumber, state.headSha);
		return merge.merged
			? { status: 'merged', message: merge.message, sha: merge.sha }
			: { status: 'not-ready', message: merge.message };
	} catch (error) {
		return classifyDirectMergeError(error);
	}
}

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

	/** Enable GitHub auto-merge as the implementer after an eligible review response. */
	async enablePullRequestAutoMerge(
		project: ProjectConfig,
		prNumber: number,
	): Promise<PullRequestAutoMergeResult> {
		const [owner, repo] = project.repo.split('/');
		return this.withCredentials(project, () => enablePullRequestAutoMerge(owner, repo, prNumber));
	}

	/**
	 * {@link ScmMergeProvider.mergePullRequest} for GitHub (issue #253): merge an
	 * approved, ready PR as the implementer, preferring GitHub's own auto-merge
	 * and falling back to a direct merge only once auto-merge is confirmed
	 * unavailable for the repository. Idempotent — a PR found already merged
	 * (e.g. a retried call) reports `merged` without attempting anything.
	 * Never throws: every refusal or unexpected failure comes back as a
	 * terminal, non-`merged` {@link MergePullRequestOutcome} so a completed,
	 * already-submitted Review can't be retroactively failed by this call.
	 */
	async mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
	): Promise<MergePullRequestOutcome> {
		const [owner, repo] = project.repo.split('/');
		return this.withCredentials(project, () => mergeReadyPullRequest(owner, repo, prNumber));
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

	async deliveryProvider(
		project: ProjectConfig,
		persona: GitHubPersona,
	): Promise<ScmDeliveryProvider> {
		const [owner, repo] = project.repo.split('/');
		const token = await getPersonaToken(project, persona);
		const login = await getGitHubUserForToken(token);
		if (!login) throw new Error(`Could not resolve GitHub identity for ${persona} persona`);
		const scoped = <T>(fn: () => Promise<T>) => this.withPersonaCredentials(project, persona, fn);
		return {
			commitIdentity: { name: login, email: `${login}@users.noreply.github.com` },
			findPullRequest: (branch) => scoped(() => findOpenPullRequest(owner, repo, branch)),
			createPullRequest: (input) => scoped(() => createPullRequest(owner, repo, input)),
			pushBranch: async (cwd, branch, expectedSha) => {
				const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
				await promisify(execFile)(
					'git',
					[
						'push',
						'--no-verify',
						`https://github.com/${project.repo}.git`,
						`${expectedSha}:refs/heads/${branch}`,
					],
					{
						cwd,
						env: {
							...process.env,
							GIT_CONFIG_COUNT: '1',
							GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
							GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
						},
					},
				);
			},
			submitReview: (input) => scoped(() => submitPullRequestReview(owner, repo, input)),
			postComment: (input) => scoped(() => postIdempotentPullRequestComment(owner, repo, input)),
		};
	}
}
