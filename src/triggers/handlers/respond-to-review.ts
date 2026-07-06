/**
 * Respond-to-review trigger — starts the Respond-to-review phase
 * (`src/pipeline/respond-to-review.ts`) when the reviewer persona submits a
 * review requesting changes (or commenting), mirroring Cascade's
 * `pr-review-submitted` trigger (ai/ARCHITECTURE.md "Pipeline phases" #4).
 *
 * Two gates make this fire on exactly the right event:
 *  - **The final submitted review, not line comments.** Only `pull_request_review`
 *    `submitted` matches; individual line comments arrive as a different event
 *    (`pull_request_review_comment`, which SWARM doesn't process) and edits /
 *    dismissals carry a non-`submitted` action. An `approved` review is nothing
 *    to respond to, so it's excluded.
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
		description: 'Starts Respond-to-review on a reviewer-persona changes-requested review',

		matches(ctx: TriggerContext): boolean {
			if (ctx.source !== 'github') return false;
			const { event } = ctx;
			if (event.eventType !== 'pull_request_review') return false;
			// Only a submitted review — not an edit or a dismissal.
			if (event.action !== 'submitted') return false;
			// Respond to changes_requested / commented, never to an approval.
			if (event.reviewState === 'approved') return false;
			return true;
		},

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'github') return null;
			const { event, project } = ctx;

			if (!event.actorLogin) {
				logger.debug('respond-to-review: review has no author — skipping');
				return null;
			}

			const identities = await resolveIdentities(project);
			const persona = getPersonaForLogin(event.actorLogin, identities);
			if (persona !== 'reviewer') {
				// A human review, or the implementer's own event — not the reviewer
				// persona's batched review, so not an auto-response trigger.
				logger.info('respond-to-review: review not authored by reviewer persona — skipping', {
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

			logger.info('respond-to-review: dispatching Respond-to-review phase', {
				prNumber,
				prBranch,
				reviewId,
			});
			return { phase: 'respond-to-review', taskId: prNumber, prNumber, prBranch, reviewId };
		},
	};
}
