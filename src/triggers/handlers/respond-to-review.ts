/**
 * Respond-to-review trigger — starts the Respond-to-review phase
 * (`src/pipeline/respond-to-review.ts`) whenever the reviewer persona submits
 * *any* review — approve, comment, or changes-requested.
 *
 * This deliberately deviates from Cascade's `pr-review-submitted` trigger
 * (which only fires on a non-approving review): the implementer should always
 * acknowledge the reviewer, not just when changes are requested — mirroring
 * the `solve-issue` skill's respond step, which unconditionally runs after
 * review regardless of verdict. Fixing valid nits and posting a reply (even a
 * plain thank-you when there's nothing to fix or push back on) is the
 * phase's job (`src/pipeline/respond-to-review.ts`'s prompt); this handler's
 * job is just recognizing that any submitted reviewer-persona review should
 * dispatch it.
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
			'Starts Respond-to-review on any reviewer-persona-submitted review (approve/comment/changes-requested)',

		matches(ctx: TriggerContext): boolean {
			if (ctx.source !== 'github') return false;
			const { event } = ctx;
			if (event.eventType !== 'pull_request_review') return false;
			// Only a submitted review — not an edit or a dismissal. Every verdict
			// (approve/comment/changes-requested) dispatches — see the module header
			// for why an approval isn't excluded.
			if (event.action !== 'submitted') return false;
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
