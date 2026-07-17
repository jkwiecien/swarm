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

/** One check on a commit — a workflow-run job, flattened. */
export interface CheckRunStatus {
	name: string;
	/** `queued` | `in_progress` | `completed` — anything but `completed` is still pending. */
	status: string;
	/** `success` | `failure` | `timed_out` | … — `null` while the check hasn't finished. */
	conclusion: string | null;
}

/** Aggregate CI state across *every* check on a commit — the basis for the review-vs-defer decision. */
export interface CheckSuiteStatus {
	totalCount: number;
	checkRuns: CheckRunStatus[];
}

/**
 * Aggregate the state of every check on `ref` (a commit SHA), so a caller can
 * decide whether CI is done rather than trusting a single `check_suite`
 * webhook's own `conclusion` — GitHub fires one `check_suite.completed` per
 * workflow, so any individual event sees only its own suite while siblings may
 * still be running.
 *
 * Ported from Cascade's `getCheckSuiteStatus`. Uses the **Actions API**
 * (workflow runs → jobs), not the Checks API: fine-grained PATs — which SWARM's
 * personas use — cannot read the Checks API, but can read Actions. Runs must be
 * deduped by `workflow_id` (keeping the most recent, since
 * `listWorkflowRunsForRepo` returns newest-first): a failed-then-rerun workflow
 * would otherwise leak its stale failing run into the aggregate and make a green
 * PR look failed.
 */
export async function getCheckSuiteStatus(
	owner: string,
	repo: string,
	ref: string,
): Promise<CheckSuiteStatus> {
	const client = getScopedClient();

	const workflowRuns = await client.paginate(client.actions.listWorkflowRunsForRepo, {
		owner,
		repo,
		head_sha: ref,
		per_page: 100,
	});

	const latestRunByWorkflow = new Map<number, (typeof workflowRuns)[number]>();
	for (const run of workflowRuns) {
		if (!latestRunByWorkflow.has(run.workflow_id)) {
			latestRunByWorkflow.set(run.workflow_id, run);
		}
	}

	const jobResults = await Promise.all(
		[...latestRunByWorkflow.values()].map((run) =>
			client.paginate(client.actions.listJobsForWorkflowRun, {
				owner,
				repo,
				run_id: run.id,
				per_page: 100,
			}),
		),
	);

	const checkRuns: CheckRunStatus[] = jobResults.flatMap((jobs) =>
		jobs.map((job) => ({
			name: job.name,
			status: job.status,
			conclusion: job.conclusion,
		})),
	);

	return { totalCount: checkRuns.length, checkRuns };
}

/**
 * Resolve the GitHub login that opened a PR (`pull_request.user.login`), or
 * `null` if the PR carries no author (e.g. a deleted account). Used by the
 * review handler's author-persona gate on the `check_suite` path, where the
 * webhook payload — unlike a `pull_request` event — carries no author, so a
 * single `pulls.get` is the only way to learn who opened the PR.
 *
 * Throws on an API failure (transient 5xx / rate-limit / network blip) rather
 * than swallowing it: the caller degrades a "can't determine authorship" error
 * to a bounded recheck, distinct from a resolved-but-not-ours author, which is a
 * definitive skip. Runs against whatever token is in scope (the reviewer
 * persona, per the aggregate query that follows it).
 */
export async function getPullRequestAuthorLogin(
	owner: string,
	repo: string,
	prNumber: number,
): Promise<string | null> {
	const client = getScopedClient();
	const { data } = await client.pulls.get({ owner, repo, pull_number: prNumber });
	return data.user?.login ?? null;
}

/**
 * Resolve a PR's title (`pull_request.title`) for a run-history row's display
 * (`tryCreateRun`, issue: PR-driven runs showed the synthetic `<pr>-respond`
 * taskId instead of a human-readable title). A single `pulls.get` — the
 * PR-driven webhook events (review / check_suite) don't carry the title. Runs
 * against whatever token is in scope. Throws on API failure; the caller treats
 * the title as best-effort and swallows it so run creation never fails for it.
 */
export async function getPullRequestTitle(
	owner: string,
	repo: string,
	prNumber: number,
): Promise<string | null> {
	const client = getScopedClient();
	const { data } = await client.pulls.get({ owner, repo, pull_number: prNumber });
	return data.title ?? null;
}

export interface ConflictCandidatePullRequest {
	number: number;
	headBranch: string;
	headSha: string;
	baseBranch: string;
	baseSha: string;
	mergeable: boolean | null;
	authorLogin: string | null;
}

/** Result of requesting GitHub's pending-check-aware pull-request auto-merge. */
export interface PullRequestAutoMergeResult {
	enabled: boolean;
	message: string;
}

/**
 * Ask GitHub to merge an open PR after all repository rules are satisfied.
 *
 * This deliberately does not inspect `mergeable`: GitHub computes that field
 * asynchronously and it is commonly `null` immediately after the implementer
 * pushes review fixes. GitHub auto-merge keeps waiting for checks/reviews (or
 * enters the repository's merge queue) instead of turning that normal pending
 * state into a lost one-shot merge attempt.
 */
export async function enablePullRequestAutoMerge(
	owner: string,
	repo: string,
	prNumber: number,
): Promise<PullRequestAutoMergeResult> {
	const client = getScopedClient();
	const { data: pull } = await client.pulls.get({ owner, repo, pull_number: prNumber });
	if (pull.state !== 'open' || pull.draft) {
		return {
			enabled: false,
			message: pull.draft
				? 'pull request is still a draft'
				: pull.state !== 'open'
					? `pull request is ${pull.state}`
					: 'pull request cannot be auto-merged',
		};
	}

	await client.graphql(
		`mutation EnablePullRequestAutoMerge($pullRequestId: ID!) {
			enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
				pullRequest { id }
			}
		}`,
		{ pullRequestId: pull.node_id },
	);
	return { enabled: true, message: 'GitHub auto-merge enabled' };
}

/** A PR's merge-relevant state — the initial lookup `mergePullRequest` needs before choosing a merge path. */
export interface PullRequestMergeState {
	merged: boolean;
	/** `open` | `closed`. */
	state: string;
	draft: boolean;
}

/** Resolve a PR's merged/state/draft flags — the same fields {@link enablePullRequestAutoMerge} checks. */
export async function getPullRequestMergeState(
	owner: string,
	repo: string,
	prNumber: number,
): Promise<PullRequestMergeState> {
	const client = getScopedClient();
	const { data } = await client.pulls.get({ owner, repo, pull_number: prNumber });
	return { merged: data.merged, state: data.state, draft: Boolean(data.draft) };
}

/** Result of a direct (non-auto) pull-request merge attempt. */
export interface DirectMergeResult {
	merged: boolean;
	message: string;
	sha?: string;
}

/**
 * Merge an open PR directly via GitHub's REST merge endpoint — the fallback
 * `GitHubSCMIntegration.mergePullRequest` uses once repository auto-merge is
 * confirmed unavailable (issue #253). Octokit throws a `RequestError` (with a
 * `.status`) on any non-2xx response — unmet required checks/reviews,
 * conflicts, a branch-protection/ruleset refusal, a merge-queue requirement,
 * ... — classifying that error into the provider-neutral outcome is the
 * adapter's job, not this primitive's; this only performs the API call and
 * leaves the merge-method choice to GitHub's own default.
 */
export async function mergePullRequestDirect(
	owner: string,
	repo: string,
	prNumber: number,
): Promise<DirectMergeResult> {
	const client = getScopedClient();
	const { data } = await client.pulls.merge({ owner, repo, pull_number: prNumber });
	return { merged: data.merged, message: data.message, sha: data.sha };
}

/** List open same-repository PRs targeting a base branch, including GitHub's asynchronous mergeability. */
export async function listOpenPullRequestsForBase(
	owner: string,
	repo: string,
	baseBranch: string,
): Promise<ConflictCandidatePullRequest[]> {
	const client = getScopedClient();
	const pulls = await client.paginate(client.pulls.list, {
		owner,
		repo,
		state: 'open',
		base: baseBranch,
		per_page: 100,
	});
	const details = await Promise.all(
		pulls.map((pull) => client.pulls.get({ owner, repo, pull_number: pull.number })),
	);
	return details
		.filter(({ data }) => data.head.repo?.full_name === data.base.repo.full_name)
		.map(({ data }) => ({
			number: data.number,
			headBranch: data.head.ref,
			headSha: data.head.sha,
			baseBranch: data.base.ref,
			baseSha: data.base.sha,
			mergeable: data.mergeable,
			authorLogin: data.user?.login ?? null,
		}));
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

/**
 * Post a top-level comment on an issue *or* a pull request — GitHub models both
 * as issues, so `issues.createComment` works for a PR number too. Returns the
 * created comment's id. Runs against whatever token is in scope (wrap in
 * `withGitHubToken` / the SCM integration's `withPersonaCredentials`).
 *
 * Used by the worker's stalled-job safety net (`reportInterruptedJobToBoard`) to
 * leave a board-visible trace on a PR whose Review phase was reclaimed mid-run —
 * the PM provider has no PR-number → comment mapping, so a review/CI job's target
 * is reached through this SCM path rather than the PM one.
 */
export async function postIssueComment(
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<number> {
	const client = getScopedClient();
	const { data } = await client.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body,
	});
	return data.id;
}

const DELIVERY_MARKER = (deliveryId: string) => `<!-- swarm-delivery:${deliveryId} -->`;

export async function findOpenPullRequest(
	owner: string,
	repo: string,
	branch: string,
): Promise<{ number: number; url: string } | undefined> {
	const client = getScopedClient();
	const { data } = await client.pulls.list({
		owner,
		repo,
		state: 'open',
		head: `${owner}:${branch}`,
	});
	const pull = data[0];
	return pull ? { number: pull.number, url: pull.html_url } : undefined;
}

export async function createPullRequest(
	owner: string,
	repo: string,
	input: { baseBranch: string; branch: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
	const client = getScopedClient();
	const { data } = await client.pulls.create({
		owner,
		repo,
		base: input.baseBranch,
		head: input.branch,
		title: input.title,
		body: input.body,
	});
	return { number: data.number, url: data.html_url };
}

export async function submitPullRequestReview(
	owner: string,
	repo: string,
	input: {
		prNumber: number;
		verdict: 'approve' | 'request-changes' | 'comment';
		body: string;
		deliveryId: string;
	},
): Promise<number> {
	const client = getScopedClient();
	const marker = DELIVERY_MARKER(input.deliveryId);
	const reviews = await client.paginate(client.pulls.listReviews, {
		owner,
		repo,
		pull_number: input.prNumber,
		per_page: 100,
	});
	const existing = reviews.find((review) => review.body?.includes(marker));
	if (existing) return existing.id;
	const event =
		input.verdict === 'approve'
			? 'APPROVE'
			: input.verdict === 'request-changes'
				? 'REQUEST_CHANGES'
				: 'COMMENT';
	const { data } = await client.pulls.createReview({
		owner,
		repo,
		pull_number: input.prNumber,
		event,
		body: `${input.body}\n\n${marker}`,
	});
	return data.id;
}

export async function postIdempotentPullRequestComment(
	owner: string,
	repo: string,
	input: { prNumber: number; body: string; deliveryId: string },
): Promise<number> {
	const client = getScopedClient();
	const marker = DELIVERY_MARKER(input.deliveryId);
	const comments = await client.paginate(client.issues.listComments, {
		owner,
		repo,
		issue_number: input.prNumber,
		per_page: 100,
	});
	const existing = comments.find((comment) => comment.body?.includes(marker));
	if (existing) return existing.id;
	const { data } = await client.issues.createComment({
		owner,
		repo,
		issue_number: input.prNumber,
		body: `${input.body}\n\n${marker}`,
	});
	return data.id;
}
