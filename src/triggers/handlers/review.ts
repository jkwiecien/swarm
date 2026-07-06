/**
 * Review trigger — starts the Review phase (`src/pipeline/review.ts`) when a PR
 * is opened or its check suite passes, mirroring Cascade's review-agent trigger
 * on `check_suite` success (ai/ARCHITECTURE.md "Pipeline phases" #3).
 *
 * Two entry events, one handler:
 *  - `pull_request` `opened` (non-draft) — review the freshly opened PR.
 *  - `check_suite` `completed` with `success` conclusion — review the commit CI
 *    just validated, which is why the phase pins its checkout to the head SHA.
 *
 * **Same-repo gate.** Fork PRs are dropped (`pull_request` events, via
 * `isCrossRepo`): the Review phase's `provision` fetches only the base repo's
 * refs, so a fork's head SHA is unreachable and the detached checkout would
 * fail the job (see `src/pipeline/review.ts`'s header). A `check_suite` payload
 * doesn't reliably tell us fork-ness, so that path can't pre-filter forks — an
 * unreachable SHA there surfaces as a failed job rather than a silent drop.
 *
 * **Cross-process dedup.** A PR that opens *and* then passes checks (or a PR
 * with several check suites) would otherwise dispatch Review more than once for
 * the same head SHA, each burning agent tokens. `handle` claims a Redis-backed
 * slot keyed on the PR+SHA (`review-dispatch-dedup.ts`) before returning a
 * dispatch; a duplicate claim short-circuits to a skip. The claim happens here,
 * at the single dispatch-decision point, so the duplicate is dropped before any
 * worktree is provisioned.
 *
 * **MVP simplifications vs Cascade** (filed as follow-ups, ai/RULES.md §5):
 *  - No incomplete-check deferral/recheck and no respond-to-ci path. SWARM keys
 *    off the suite's own aggregate `conclusion` rather than re-querying every
 *    check run on the SHA, and has no respond-to-ci phase to route CI failures
 *    to. A non-`success` suite is simply not a review trigger.
 */

import { logger } from '../../lib/logger.js';
import type { GitHubParsedEvent } from '../../router/adapters/github.js';
import { buildReviewDispatchKey, claimReviewDispatch } from '../review-dispatch-dedup.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

/**
 * True when the event is a review entry point by *shape* — an opened PR or a
 * completed check suite. The success/draft/fork specifics are decided in
 * `handle` so a near-miss can fall through to the registry's next handler.
 */
function matchesReviewShape(ctx: TriggerContext): boolean {
	if (ctx.source !== 'github') return false;
	const { event } = ctx;
	if (event.eventType === 'pull_request' && event.action === 'opened') return true;
	if (event.eventType === 'check_suite' && event.action === 'completed') return true;
	return false;
}

/**
 * Whether a shape-matched event is actually reviewable — the event-type-specific
 * gate: a `pull_request` must be a non-draft, same-repo PR; a `check_suite` must
 * have passed. Logs and returns false on a near-miss so `handle` can fall
 * through to the registry's next handler.
 */
function isReviewableEvent(event: GitHubParsedEvent, prNumber: string): boolean {
	if (event.eventType === 'pull_request') {
		if (event.isDraft) {
			logger.debug('review: PR is a draft — skipping', { prNumber });
			return false;
		}
		if (event.isCrossRepo) {
			logger.info('review: fork PR — skipping (head SHA unreachable for review)', { prNumber });
			return false;
		}
		return true;
	}
	// check_suite: only a passing suite is a review trigger.
	if (event.checkConclusion !== 'success') {
		logger.debug('review: check suite did not succeed — skipping', {
			prNumber,
			conclusion: event.checkConclusion,
		});
		return false;
	}
	return true;
}

export function createReviewTrigger(): TriggerHandler {
	return {
		name: 'pr-review',
		description: 'Starts the Review phase on a PR opened / check suite success',

		matches: matchesReviewShape,

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'github') return null;
			const { event } = ctx;

			const prNumber = event.workItemId;
			if (!prNumber) {
				// A check suite with no associated PR, or a PR event missing its number —
				// nothing to review.
				logger.debug('review: event carries no PR number — skipping', {
					eventType: event.eventType,
				});
				return null;
			}

			if (!isReviewableEvent(event, prNumber)) return null;

			if (!event.headSha) {
				// The Review phase pins its checkout to the head SHA; without it there's
				// nothing to review against.
				logger.warn('review: event carries no head SHA — skipping', {
					prNumber,
					eventType: event.eventType,
				});
				return null;
			}

			// Cross-process dedup: claim this PR+SHA before dispatching so a sibling
			// event for the same commit (PR opened → check suite passed, or one
			// success per CI suite) doesn't launch a second review. Fails closed, so
			// a claim we can't obtain (duplicate, or Redis down) drops to a skip.
			const dispatchKey = buildReviewDispatchKey(ctx.project.repo, prNumber, event.headSha);
			const claimed = await claimReviewDispatch(dispatchKey, 'pr-review', {
				prNumber,
				headSha: event.headSha,
			});
			if (!claimed) return null;

			logger.info('review: dispatching Review phase', { prNumber, headSha: event.headSha });
			return { phase: 'review', taskId: prNumber, prNumber, headSha: event.headSha };
		},
	};
}
