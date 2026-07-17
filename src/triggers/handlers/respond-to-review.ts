/**
 * Respond-to-review trigger — starts the Respond-to-review phase
 * (`src/pipeline/respond-to-review.ts`) whenever the reviewer persona submits
 * a reviewer-persona review. By default it only starts when that review requests
 * changes, avoiding a separate agent run for approvals and minor comments.
 *
 * Set `pipeline.respondToReview.skipOnMinors` to `false` to restore the former
 * every-verdict behaviour, including an acknowledgement after an approval. This
 * handler decides whether the review warrants a run; the phase itself remains
 * responsible for addressing the batched findings it receives.
 *
 * Two gates make this fire on exactly the right event:
 *  - **The final submitted review, not line comments.** Only `pull_request_review`
 *    `submitted` matches; individual line comments arrive as a different event
 *    (`pull_request_review_comment`, which SWARM doesn't process) and edits /
 *    dismissals carry a non-`submitted` action.
 *  - **Authored by the reviewer persona.** GitHub self-review is impossible, so
 *    a human's review or the implementer's own event must not start a response.
 *    `getPersonaForLogin` confirms the review's author is the *reviewer* persona
 *    before dispatching — the same routing primitive the router adapter uses.
 *
 * **The two-verdict safety cap (issue #235).** A `changes_requested` event that
 * is the second (and last permitted) verdict the review-verdict ledger allowed
 * (`src/db/repositories/reviewVerdictsRepository.ts`) stops the cycle here
 * instead of dispatching another Respond-to-review run: the PR needs a human
 * to intervene, not a third automatic review. The ledger record is resolved by
 * the submitted review's id, falling back to PR/head for the narrow webhook
 * race before the Review phase has stored it; a lookup error or a missing
 * record for a `changes_requested` event fails closed (skips the dispatch)
 * rather than risk reopening an unbounded cycle on a persistence outage.
 */

import type { ProjectConfig } from '../../config/schema.js';
import {
	getReviewVerdictByHead as getReviewVerdictByHeadDefault,
	getReviewVerdictByReviewId as getReviewVerdictByReviewIdDefault,
	isCapReachingRequestChanges,
} from '../../db/repositories/reviewVerdictsRepository.js';
import {
	getPersonaForLogin,
	resolvePersonaIdentities,
} from '../../integrations/scm/github/personas.js';
import { logger } from '../../lib/logger.js';
import type { GitHubParsedEvent } from '../../router/adapters/github.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

/**
 * Resolve the PR/branch/review/head coordinates the phase (and the safety-cap
 * ledger fallback lookup) need, or `null` — logging why — when any is
 * missing from the event.
 */
function resolveReviewCoordinates(
	event: GitHubParsedEvent,
): { prNumber: string; prBranch: string; reviewId: string; headSha: string } | null {
	const { workItemId: prNumber, prBranch, reviewId, headSha } = event;
	if (!prNumber || !prBranch || !reviewId || !headSha) {
		logger.warn('respond-to-review: event missing PR/branch/review/head coordinates — skipping', {
			prNumber,
			hasBranch: !!prBranch,
			hasReviewId: !!reviewId,
			hasHeadSha: !!headSha,
		});
		return null;
	}
	return { prNumber, prBranch, reviewId, headSha };
}

export interface RespondToReviewTriggerDeps {
	/** Injectable persona-identity resolver — defaults to the cached resolver; overridden in tests. */
	resolveIdentities?: (
		project: ProjectConfig,
	) => Promise<Awaited<ReturnType<typeof resolvePersonaIdentities>>>;
	/**
	 * Injectable review-verdict ledger lookups (issue #235) — default to the real
	 * repository calls; overridden in tests.
	 */
	getReviewVerdictByReviewId?: typeof getReviewVerdictByReviewIdDefault;
	getReviewVerdictByHead?: typeof getReviewVerdictByHeadDefault;
}

export function createRespondToReviewTrigger(
	deps: RespondToReviewTriggerDeps = {},
): TriggerHandler {
	const resolveIdentities = deps.resolveIdentities ?? resolvePersonaIdentities;
	const getReviewVerdictByReviewId =
		deps.getReviewVerdictByReviewId ?? getReviewVerdictByReviewIdDefault;
	const getReviewVerdictByHead = deps.getReviewVerdictByHead ?? getReviewVerdictByHeadDefault;

	/**
	 * Whether the safety cap clears this event for dispatch — `true` for
	 * anything but a `changes_requested` review, which must resolve the
	 * review-verdict ledger first. Returns `false` (skip the dispatch) for the
	 * cap-reaching second verdict, a lookup error, or a missing ledger record
	 * (all "fail closed" — see the module header); all logging for the skip
	 * case happens here so `handle` stays a single guard clause.
	 */
	async function isClearedForDispatch(
		project: ProjectConfig,
		reviewState: string | undefined,
		prNumber: string,
		headSha: string,
		reviewId: string,
	): Promise<boolean> {
		if (reviewState !== 'changes_requested') return true;
		try {
			const record =
				(await getReviewVerdictByReviewId(project.id, project.repo, reviewId)) ??
				(await getReviewVerdictByHead(project.id, project.repo, prNumber, headSha));
			if (!record) {
				logger.error(
					'respond-to-review: no review-verdict ledger record for this changes-requested review — failing closed',
					{ prNumber, headSha, reviewId },
				);
				return false;
			}
			if (isCapReachingRequestChanges(record.ordinal, record.verdict)) {
				logger.warn(
					'respond-to-review: second changes-requested verdict reached the review cap — stopping the automatic cycle (manual intervention required)',
					{ prNumber, headSha, reviewId },
				);
				return false;
			}
			return true;
		} catch (err) {
			logger.error('respond-to-review: failed to read review-verdict cap state — failing closed', {
				prNumber,
				headSha,
				reviewId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	return {
		name: 'pr-review-submitted',
		description:
			'Starts Respond-to-review on a reviewer-persona changes-requested review (or every verdict when skipOnMinors is false)',

		matches(ctx: TriggerContext): boolean {
			if (ctx.source !== 'github') return false;
			const { event } = ctx;
			if (event.eventType !== 'pull_request_review') return false;
			// Only a submitted review — not an edit or a dismissal. `handle` applies
			// the configured verdict policy after this cheap shape match.
			if (event.action !== 'submitted') return false;
			return true;
		},

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'github') return null;
			const { event, project } = ctx;
			if (project.pipeline?.respondToReview?.enabled === false) {
				logger.debug('respond-to-review: phase disabled — skipping');
				return null;
			}
			if (
				project.pipeline?.respondToReview?.skipOnMinors !== false &&
				event.reviewState !== 'changes_requested'
			) {
				logger.debug('respond-to-review: minor review skipped by project setting', {
					reviewState: event.reviewState,
				});
				return null;
			}

			if (!event.actorLogin) {
				logger.debug('respond-to-review: review has no author — skipping');
				return null;
			}

			const identities = await resolveIdentities(project);
			const persona = getPersonaForLogin(event.actorLogin, identities);
			if (persona !== 'reviewer') {
				// A human review, or the implementer's own event — not the reviewer
				// persona's batched review, so not an auto-response trigger.
				logger.debug('respond-to-review: review not authored by reviewer persona — skipping', {
					reviewAuthor: event.actorLogin,
					expectedReviewer: identities.reviewer,
				});
				return null;
			}

			const coords = resolveReviewCoordinates(event);
			if (!coords) return null;
			const { prNumber, prBranch, reviewId, headSha } = coords;

			if (!(await isClearedForDispatch(project, event.reviewState, prNumber, headSha, reviewId))) {
				return null;
			}

			logger.debug('respond-to-review: dispatching Respond-to-review phase', {
				prNumber,
				prBranch,
				reviewId,
			});
			// Suffixed, not bare `prNumber`: the Review phase's own worktree
			// (`task-<prNumber>`) can still be open when this dispatches — a review
			// verdict fires this trigger the moment it's submitted, well before the
			// review agent's process (and its worktree cleanup) actually exits. A
			// shared taskId would make the two `provision` calls race for one
			// worktree path (see git history for the incident this fixed).
			return {
				phase: 'respond-to-review',
				taskId: `${prNumber}-respond`,
				prNumber,
				prBranch,
				reviewId,
			};
		},
	};
}
