/**
 * The aggregate-check-state decision for the `pr-review` handler
 * (`src/triggers/handlers/review.ts`), ported from Cascade's
 * `check-suite-decision.ts`.
 *
 * GitHub fires one `check_suite.completed` per workflow, so no single event
 * knows whether CI as a whole is done. Given the aggregate state of *every*
 * check on the head SHA (`getCheckSuiteStatus`), this decides the one thing the
 * handler needs: review now, defer and re-check later, or skip. It is a pure
 * function of the aggregate — the author/draft/fork gates live in the handler —
 * so it unit-tests without any GitHub or queue plumbing.
 */

import type { CheckSuiteStatus } from '../../integrations/scm/github/client.js';

/** Conclusions that count as a failed check — a suite in any of these is not reviewable. */
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

export type CheckSuiteDecision =
	| { action: 'defer'; incompleteChecks: string[]; message: string }
	| { action: 'review' }
	| { action: 'skip'; message: string };

/**
 * Decide what to do with a PR's aggregate CI state:
 *
 *  - `defer`  — some check hasn't reached `completed`. The caller schedules a
 *    coalesced re-check so a stale Actions API (which can lag the webhook that
 *    woke us) is re-queried rather than trusted once.
 *  - `skip`   — every check completed and at least one failed. SWARM has no
 *    respond-to-ci phase yet (#64), so a failed suite is simply not a review
 *    trigger — not an error.
 *  - `review` — every check completed and none failed. (Zero checks also
 *    resolves here, mirroring Cascade: a `check_suite.completed` event means CI
 *    ran, and the dispatch dedup guards against a premature double-review.)
 */
export function decideCheckSuiteOutcome(
	checkStatus: CheckSuiteStatus,
	prNumber: string,
): CheckSuiteDecision {
	const incompleteChecks = checkStatus.checkRuns
		.filter((cr) => cr.status !== 'completed')
		.map((cr) => cr.name);
	if (incompleteChecks.length > 0) {
		return {
			action: 'defer',
			incompleteChecks,
			message: `PR #${prNumber}: ${incompleteChecks.length}/${checkStatus.totalCount} checks still running (${incompleteChecks.join(', ')})`,
		};
	}

	const anyFailed = checkStatus.checkRuns.some(
		(cr) => cr.conclusion !== null && FAILURE_CONCLUSIONS.has(cr.conclusion),
	);
	if (anyFailed) {
		return {
			action: 'skip',
			message: `PR #${prNumber}: a check failed — no review (respond-to-ci is deferred to #64)`,
		};
	}

	return { action: 'review' };
}
