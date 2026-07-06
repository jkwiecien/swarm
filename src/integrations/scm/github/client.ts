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
