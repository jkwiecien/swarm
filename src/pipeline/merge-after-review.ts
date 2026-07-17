/**
 * Provider-neutral merge-after-approval (issue #253, supersedes the
 * GitHub-only auto-merge helper from issue #231). Armed only from the Review
 * phase's own `approve` verdict (`src/pipeline/review.ts`), restricted to this
 * single call site (issue #235). `pipeline.respondToReview.autoMerge` gates
 * it: when on and the verdict is `approve`, ask the injected
 * `ScmMergeProvider` (`src/scm/merge.ts`) to merge the PR — GitHub's adapter
 * prefers its own auto-merge and falls back to a direct merge only once
 * auto-merge is confirmed unavailable; a future Bitbucket/GitLab adapter maps
 * its native automation the same way, with no change here.
 *
 * Respond-to-review deliberately does **not** call this: none of its outcomes
 * (`fixed`, `pushed-back`, `no-findings`) are an approval of the review that
 * blocked the PR — only a fresh submitted Review approval clears that gate
 * (issue #235), even after the implementer has addressed every point.
 *
 * Strictly best-effort: every non-`merged` outcome (`not-ready`,
 * `policy-blocked`, `unsupported`, `provider-error`) is logged and swallowed,
 * never turning an otherwise-successful phase into a failed run — merging
 * itself is the provider's job; this only requests it.
 */

import type { ProjectConfig } from '@/config/schema.js';
import { logger } from '@/lib/logger.js';
import type { MergePullRequest, MergePullRequestOutcome } from '@/scm/merge.js';

export interface MergeAfterReviewOptions {
	/** `pipeline.respondToReview.autoMerge` — the setting that gates this call. */
	enabled: boolean;
	/** Whether this verdict leaves the PR eligible for merge automation (an `approve`). */
	eligible: boolean;
	/** The (possibly injected) provider operation. */
	mergePullRequest: MergePullRequest;
	project: ProjectConfig;
	prNumber: string;
	taskId: string;
	/** Human phase name for the log lines — always `'Review'`, the sole call site. */
	phase: string;
}

/**
 * Request a merge when merge automation is enabled and the phase result is
 * merge-eligible. Returns the provider's outcome, or `undefined` when the
 * gate or eligibility didn't apply (the provider is then never called).
 *
 * Never throws: a rejection the provider raises instead of returning is
 * normalized to a `provider-error` outcome, and every outcome is logged here
 * rather than propagated — a merge refusal or a bug/outage in the adapter must
 * not retroactively fail an already-completed, already-submitted Review.
 */
export async function mergeAfterReviewIfEligible(
	options: MergeAfterReviewOptions,
): Promise<MergePullRequestOutcome | undefined> {
	const { enabled, eligible, mergePullRequest, project, prNumber, taskId, phase } = options;
	if (!enabled || !eligible) return undefined;

	let outcome: MergePullRequestOutcome;
	try {
		outcome = await mergePullRequest(project, Number(prNumber));
	} catch (error) {
		outcome = {
			status: 'provider-error',
			message: error instanceof Error ? error.message : String(error),
		};
	}

	if (outcome.status === 'merged') {
		logger.info(`${phase} merged pull request`, { taskId, prNumber, message: outcome.message });
	} else {
		logger.warn(`${phase} did not merge pull request`, {
			taskId,
			prNumber,
			status: outcome.status,
			reason: outcome.message,
		});
	}
	return outcome;
}
