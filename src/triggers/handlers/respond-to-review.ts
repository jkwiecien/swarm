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
 */

import type { ProjectConfig } from '../../config/schema.js';
import {
	getPersonaForLogin,
	resolvePersonaIdentities,
} from '../../integrations/scm/github/personas.js';
import { logger } from '../../lib/logger.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

export interface RespondToReviewTriggerDeps {
	/** Injectable persona-identity resolver — defaults to the cached resolver; overridden in tests. */
	resolveIdentities?: (
		project: ProjectConfig,
	) => Promise<Awaited<ReturnType<typeof resolvePersonaIdentities>>>;
}

export function createRespondToReviewTrigger(
	deps: RespondToReviewTriggerDeps = {},
): TriggerHandler {
	const resolveIdentities = deps.resolveIdentities ?? resolvePersonaIdentities;

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

			const { workItemId: prNumber, prBranch, reviewId } = event;
			if (!prNumber || !prBranch || !reviewId) {
				// The phase needs all three to check out the branch and pin the review.
				logger.warn('respond-to-review: event missing PR/branch/review coordinates — skipping', {
					prNumber,
					hasBranch: !!prBranch,
					hasReviewId: !!reviewId,
				});
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
