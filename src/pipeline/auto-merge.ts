/**
 * Best-effort GitHub auto-merge, armed only from the Review phase's own
 * `approve` verdict (`src/pipeline/review.ts`, issue #231; restricted to this
 * single call site by issue #235). `pipeline.respondToReview.autoMerge` gates
 * it: when on and the verdict is `approve`, ask GitHub to merge the PR once
 * its own required reviews and checks pass.
 *
 * Respond-to-review deliberately does **not** call this: none of its outcomes
 * (`fixed`, `pushed-back`, `no-findings`) are an approval of the review that
 * blocked the PR — only a fresh submitted Review approval clears that gate
 * (issue #235), even after the implementer has addressed every point.
 *
 * Strictly best-effort: a provider refusal (a draft PR, a closed PR, no
 * merge-queue configured) or an error is logged and swallowed, never turning an
 * otherwise-successful phase into a failed run. Merging itself stays GitHub's
 * job — this only arms auto-merge; the provider deliberately doesn't gate on
 * `mergeable` (commonly `null` right after a push — see
 * `enablePullRequestAutoMerge` in `src/integrations/scm/github/client.ts`).
 */

import type { ProjectConfig } from '@/config/schema.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import { logger } from '@/lib/logger.js';

/** Signature of the auto-merge operation both phases inject (overridden in tests). */
export type EnablePullRequestAutoMerge = (
	project: ProjectConfig,
	prNumber: number,
) => Promise<{ enabled: boolean; message: string }>;

/** Production default — the GitHub SCM integration's pending-check-aware auto-merge. */
export const enablePullRequestAutoMergeDefault: EnablePullRequestAutoMerge = (project, prNumber) =>
	new GitHubSCMIntegration().enablePullRequestAutoMerge(project, prNumber);

export interface EnableAutoMergeOptions {
	/** `pipeline.respondToReview.autoMerge` — the setting that gates this call. */
	enabled: boolean;
	/** Whether this verdict leaves the PR safe to hand to GitHub for merge (an `approve`). */
	eligible: boolean;
	/** The (possibly injected) provider operation. */
	enablePullRequestAutoMerge: EnablePullRequestAutoMerge;
	project: ProjectConfig;
	prNumber: string;
	taskId: string;
	/** Human phase name for the log lines — always `'Review'`, the sole call site. */
	phase: string;
}

/**
 * Arm GitHub auto-merge when it's enabled and the phase result is
 * merge-eligible. Returns whether GitHub accepted the request, or `undefined`
 * when the gate or eligibility didn't apply (the provider is then never called).
 */
export async function enableAutoMergeIfEligible(
	options: EnableAutoMergeOptions,
): Promise<boolean | undefined> {
	const { enabled, eligible, enablePullRequestAutoMerge, project, prNumber, taskId, phase } =
		options;
	if (!enabled || !eligible) return undefined;
	try {
		const merge = await enablePullRequestAutoMerge(project, Number(prNumber));
		if (merge.enabled) {
			logger.info(`${phase} enabled GitHub auto-merge for pull request`, { taskId, prNumber });
		} else {
			logger.warn(`${phase} did not enable GitHub auto-merge`, {
				taskId,
				prNumber,
				reason: merge.message,
			});
		}
		return merge.enabled;
	} catch (error) {
		logger.warn(`${phase} could not enable GitHub auto-merge — the completed phase is unaffected`, {
			taskId,
			prNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
