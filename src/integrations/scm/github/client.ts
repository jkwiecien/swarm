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
