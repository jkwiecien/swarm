/**
 * Provider-neutral merge capability (issue #253). GitHub's built-in auto-merge
 * can be disallowed by repository settings even when a SWARM Review approves a
 * PR and the project opts into merge automation, so the Review pipeline needs
 * a direct-merge fallback — without hard-coding GitHub into the pipeline
 * (`ai/RULES.md` "Source-control features must not hard-code GitHub").
 *
 * Mirrors `src/scm/delivery.ts`'s `ScmDeliveryProvider` seam: pipeline code
 * depends on {@link ScmMergeProvider} only, never on a provider's own client or
 * vocabulary ("pull request" here, not GitHub's `pulls.merge` or GitLab's
 * "merge request"). GitHub is the only implementation today
 * (`GitHubSCMIntegration.mergePullRequest`,
 * `src/integrations/scm/github/scm-integration.ts`); Bitbucket and GitLab
 * adapters implement the same interface, mapping their native PR/MR merge
 * responses onto {@link MergePullRequestOutcome}, with no pipeline changes.
 */

import type { ProjectConfig } from '../config/schema.js';

/**
 * Terminal outcome of one merge attempt. Every non-`merged` status is a
 * normal, visible refusal — never a thrown error — so a merge attempt can
 * never retroactively fail an already-submitted, completed Review.
 *
 * - `merged` — the request is merged now, or was already merged (a retry
 *   after a prior success is idempotent).
 * - `not-ready` — a transient readiness condition blocks merging right now:
 *   unsatisfied/pending required checks, unresolved conflicts, or GitHub
 *   still converging on required-review state right after a submission
 *   (including "the provider's own auto-merge is now armed and waiting on
 *   those same conditions"). Expected to clear on its own; the request is
 *   left open for a later attempt or the provider's own automation to
 *   complete.
 * - `not-eligible` — the approval this attempt was requested for no longer
 *   holds: the head moved (new commits pushed since the review), the PR was
 *   closed or converted back to a draft, or the approving review was
 *   overridden (changes requested since). Distinct from `not-ready`: this
 *   will not clear on its own — it needs a fresh review before merge
 *   automation can proceed again.
 * - `policy-blocked` — a repository policy (branch protection, a ruleset, a
 *   permission restriction) refuses the merge outright; it will not clear on
 *   its own and needs a human to change the policy or merge manually.
 * - `unsupported` — this adapter has no way to perform the requested merge —
 *   a repository configuration this adapter doesn't implement (e.g. a
 *   required merge queue), or a provider that hasn't implemented the
 *   capability at all.
 * - `provider-error` — an unexpected API, authentication, rate-limit, or
 *   transport failure. Distinct from every refusal above: it reflects the
 *   provider being unreachable/misbehaving, not the request's own readiness
 *   or a deliberate policy.
 */
export type MergePullRequestOutcome =
	| { status: 'merged'; message: string; sha?: string }
	| { status: 'not-ready'; message: string }
	| { status: 'not-eligible'; message: string }
	| { status: 'policy-blocked'; message: string }
	| { status: 'unsupported'; message: string }
	| { status: 'provider-error'; message: string };

/**
 * Provider-neutral capability: merge an approved, ready pull/merge request.
 * `prNumber` is deliberately generic (GitLab calls it an "IID"; GitHub a PR
 * number) — the concrete adapter resolves whatever identifier its own API
 * needs from `project` + `prNumber`. `approvedHeadSha` is the commit the
 * approval actually covers (the reviewed head) — every call, including a
 * durable retry long after the original approval, re-checks the PR's
 * *current* head against it so a merge never lands a commit nobody reviewed.
 */
export interface ScmMergeProvider {
	mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
		approvedHeadSha: string,
	): Promise<MergePullRequestOutcome>;
}

/** Injectable function type mirroring {@link ScmMergeProvider.mergePullRequest} for phase options. */
export type MergePullRequest = ScmMergeProvider['mergePullRequest'];
