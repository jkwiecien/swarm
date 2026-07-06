import { describe, expect, it } from 'vitest';
import { createReviewTrigger } from '@/triggers/handlers/review.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createMockGitHubParsedEvent,
	createMockProjectConfig,
} from '../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const handler = createReviewTrigger();

function ctx(
	overrides: Partial<Parameters<typeof createMockGitHubParsedEvent>[0]> = {},
): TriggerContext {
	return { project: PROJECT, source: 'github', event: createMockGitHubParsedEvent(overrides) };
}

describe('review trigger', () => {
	describe('matches', () => {
		it('matches a PR opened', () => {
			expect(handler.matches(ctx({ eventType: 'pull_request', action: 'opened' }))).toBe(true);
		});

		it('matches a completed check suite', () => {
			expect(handler.matches(ctx({ eventType: 'check_suite', action: 'completed' }))).toBe(true);
		});

		it('ignores other PR actions', () => {
			expect(handler.matches(ctx({ eventType: 'pull_request', action: 'closed' }))).toBe(false);
		});

		it('ignores a projects source', () => {
			const projectsCtx = {
				project: PROJECT,
				source: 'github-projects',
				event: { eventType: 'projects_v2_item' },
			} as unknown as TriggerContext;
			expect(handler.matches(projectsCtx)).toBe(false);
		});
	});

	describe('handle — pull_request opened', () => {
		const base = { eventType: 'pull_request', action: 'opened', workItemId: '42' } as const;

		it('dispatches Review for a non-draft same-repo PR', async () => {
			const result = await handler.handle(
				ctx({ ...base, headSha: 'abc123', isDraft: false, isCrossRepo: false }),
			);
			expect(result).toEqual({
				phase: 'review',
				taskId: '42',
				prNumber: '42',
				headSha: 'abc123',
			});
		});

		it('skips a draft PR', async () => {
			expect(await handler.handle(ctx({ ...base, headSha: 'abc', isDraft: true }))).toBeNull();
		});

		it('skips a fork PR', async () => {
			expect(await handler.handle(ctx({ ...base, headSha: 'abc', isCrossRepo: true }))).toBeNull();
		});

		it('skips when no head SHA is present', async () => {
			expect(await handler.handle(ctx({ ...base, isCrossRepo: false }))).toBeNull();
		});
	});

	describe('handle — check_suite', () => {
		const base = { eventType: 'check_suite', action: 'completed', workItemId: '9' } as const;

		it('dispatches Review on a successful suite', async () => {
			const result = await handler.handle(
				ctx({ ...base, checkConclusion: 'success', headSha: 'cafe' }),
			);
			expect(result).toEqual({ phase: 'review', taskId: '9', prNumber: '9', headSha: 'cafe' });
		});

		it('skips a non-success conclusion', async () => {
			expect(
				await handler.handle(ctx({ ...base, checkConclusion: 'failure', headSha: 'cafe' })),
			).toBeNull();
		});

		it('skips a suite with no associated PR', async () => {
			expect(
				await handler.handle(
					ctx({
						eventType: 'check_suite',
						action: 'completed',
						workItemId: undefined,
						checkConclusion: 'success',
						headSha: 'cafe',
					}),
				),
			).toBeNull();
		});
	});
});
