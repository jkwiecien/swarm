import { describe, expect, it } from 'vitest';
import type { PersonaIdentities } from '@/integrations/scm/github/personas.js';
import { createRespondToReviewTrigger } from '@/triggers/handlers/respond-to-review.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createMockGitHubParsedEvent,
	createMockProjectConfig,
} from '../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const IDENTITIES: PersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };

// Real getPersonaForLogin runs against these identities — only identity
// *resolution* is stubbed (it would otherwise hit GitHub).
const handler = createRespondToReviewTrigger({ resolveIdentities: async () => IDENTITIES });

function reviewEvent(overrides: Partial<Parameters<typeof createMockGitHubParsedEvent>[0]> = {}) {
	return createMockGitHubParsedEvent({
		eventType: 'pull_request_review',
		action: 'submitted',
		workItemId: '17',
		reviewState: 'changes_requested',
		reviewId: '555',
		prBranch: 'issue-17',
		actorLogin: 'swarm-rev',
		...overrides,
	});
}

function ctx(
	overrides: Partial<Parameters<typeof createMockGitHubParsedEvent>[0]> = {},
): TriggerContext {
	return { project: PROJECT, source: 'github', event: reviewEvent(overrides) };
}

describe('respond-to-review trigger', () => {
	describe('matches', () => {
		it('matches a submitted changes_requested review', () => {
			expect(handler.matches(ctx())).toBe(true);
		});

		it('matches a submitted commented review', () => {
			expect(handler.matches(ctx({ reviewState: 'commented' }))).toBe(true);
		});

		it('matches an approved review too — the implementer always responds', () => {
			expect(handler.matches(ctx({ reviewState: 'approved' }))).toBe(true);
		});

		it('ignores a non-submitted action (edit/dismiss)', () => {
			expect(handler.matches(ctx({ action: 'edited' }))).toBe(false);
		});

		it('ignores other event types', () => {
			expect(handler.matches(ctx({ eventType: 'pull_request', action: 'opened' }))).toBe(false);
		});
	});

	describe('handle', () => {
		it('dispatches Respond-to-review for a reviewer-persona review', async () => {
			const result = await handler.handle(ctx());
			expect(result).toEqual({
				phase: 'respond-to-review',
				taskId: '17-respond',
				prNumber: '17',
				prBranch: 'issue-17',
				reviewId: '555',
			});
		});

		it('dispatches when no pipeline config is present', async () => {
			const result = await handler.handle({ ...ctx(), project: createMockProjectConfig() });
			expect(result).toMatchObject({ phase: 'respond-to-review', prNumber: '17' });
		});

		it('skips when Respond-to-review is disabled', async () => {
			const project = createMockProjectConfig({
				pipeline: { respondToReview: { enabled: false } },
			});
			expect(await handler.handle({ ...ctx(), project })).toBeNull();
		});

		it('also dispatches for an approved reviewer-persona review', async () => {
			const result = await handler.handle(ctx({ reviewState: 'approved' }));
			expect(result).toMatchObject({ phase: 'respond-to-review', prNumber: '17' });
		});

		it('skips a review authored by a human', async () => {
			expect(await handler.handle(ctx({ actorLogin: 'a-human' }))).toBeNull();
		});

		it('skips a review authored by the implementer persona', async () => {
			expect(await handler.handle(ctx({ actorLogin: 'swarm-impl' }))).toBeNull();
		});

		it('recognizes a [bot]-suffixed reviewer login', async () => {
			const result = await handler.handle(ctx({ actorLogin: 'swarm-rev[bot]' }));
			expect(result).toMatchObject({ phase: 'respond-to-review', prNumber: '17' });
		});

		it('skips when the review coordinates are incomplete', async () => {
			expect(await handler.handle(ctx({ prBranch: undefined }))).toBeNull();
			expect(await handler.handle(ctx({ reviewId: undefined }))).toBeNull();
		});

		it('skips when the review has no author', async () => {
			expect(await handler.handle(ctx({ actorLogin: undefined }))).toBeNull();
		});
	});
});
