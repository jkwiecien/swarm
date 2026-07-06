import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckSuiteStatus } from '@/integrations/scm/github/client.js';
import { createReviewTrigger } from '@/triggers/handlers/review.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createMockGitHubParsedEvent,
	createMockProjectConfig,
} from '../../../helpers/factories.js';

// The handler gates dispatch on a Redis-backed dedup claim; mock it so these
// tests stay pure-in-memory. `claimReviewDispatch` defaults to granting the
// claim (the common path); individual tests flip it to exercise a skip.
const { claimReviewDispatch } = vi.hoisted(() => ({ claimReviewDispatch: vi.fn() }));
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	claimReviewDispatch,
	buildReviewDispatchKey: (repo: string, prNumber: string, headSha: string) =>
		`${repo}:${prNumber}:${headSha}`,
}));

// A `check_suite` event re-queries aggregate CI state and may schedule a
// coalesced recheck — mock both so the tests need neither GitHub nor Redis.
const { getCheckSuiteStatus, scheduleCoalescedJob, withPersonaCredentials } = vi.hoisted(() => ({
	getCheckSuiteStatus: vi.fn(),
	scheduleCoalescedJob: vi.fn(),
	withPersonaCredentials: vi.fn(),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({ getCheckSuiteStatus }));
vi.mock('@/queue/producer.js', () => ({ scheduleCoalescedJob }));
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		withPersonaCredentials = withPersonaCredentials;
	},
}));

/** Build a `CheckSuiteStatus` from `[name, status, conclusion]` triples. */
function checkStatus(runs: Array<[string, string, string | null]>): CheckSuiteStatus {
	return {
		totalCount: runs.length,
		checkRuns: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })),
	};
}

beforeEach(() => {
	claimReviewDispatch.mockReset();
	claimReviewDispatch.mockResolvedValue(true);
	getCheckSuiteStatus.mockReset();
	scheduleCoalescedJob.mockReset();
	// The integration just runs the callback under (mocked) credentials.
	withPersonaCredentials.mockReset();
	withPersonaCredentials.mockImplementation(
		(_project: unknown, _persona: unknown, fn: () => Promise<unknown>) => fn(),
	);
});

const PROJECT = createMockProjectConfig();
const handler = createReviewTrigger();

function ctx(
	overrides: Partial<Parameters<typeof createMockGitHubParsedEvent>[0]> = {},
	extra: { recheckAttempt?: number; deliveryId?: string } = {},
): TriggerContext {
	return {
		project: PROJECT,
		source: 'github',
		event: createMockGitHubParsedEvent(overrides),
		...extra,
	};
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

		it('does not query check state for a PR event', async () => {
			await handler.handle(ctx({ ...base, headSha: 'abc123', isDraft: false, isCrossRepo: false }));
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
		});
	});

	describe('handle — check_suite', () => {
		const base = { eventType: 'check_suite', action: 'completed', workItemId: '9' } as const;

		it('dispatches Review when all checks completed and none failed', async () => {
			getCheckSuiteStatus.mockResolvedValue(
				checkStatus([
					['build', 'completed', 'success'],
					['test', 'completed', 'success'],
				]),
			);
			const result = await handler.handle(ctx({ ...base, headSha: 'cafe' }));
			expect(result).toEqual({ phase: 'review', taskId: '9', prNumber: '9', headSha: 'cafe' });
			expect(getCheckSuiteStatus).toHaveBeenCalledWith('jkwiecien', 'swarm', 'cafe');
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('skips (no review) when a check failed', async () => {
			getCheckSuiteStatus.mockResolvedValue(
				checkStatus([
					['build', 'completed', 'success'],
					['test', 'completed', 'failure'],
				]),
			);
			expect(await handler.handle(ctx({ ...base, headSha: 'cafe' }))).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
		});

		it('defers and schedules a coalesced recheck when a check is still running', async () => {
			getCheckSuiteStatus.mockResolvedValue(
				checkStatus([
					['build', 'completed', 'success'],
					['test', 'in_progress', null],
				]),
			);
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { deliveryId: 'd-1' })),
			).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			const [job, coalesceKey, delayMs] = scheduleCoalescedJob.mock.calls[0];
			expect(coalesceKey).toBe(`check-suite:${PROJECT.repo}:9:cafe`);
			expect(delayMs).toBe(30_000);
			expect(job).toMatchObject({
				type: 'github',
				projectId: PROJECT.id,
				deliveryId: 'd-1',
				recheckAttempt: 1,
			});
		});

		it('increments recheckAttempt across successive rechecks', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'queued', null]]));
			await handler.handle(ctx({ ...base, headSha: 'cafe' }, { recheckAttempt: 4 }));
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({ recheckAttempt: 5 });
		});

		it('stops rescheduling once the recheck cap is reached', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { recheckAttempt: 20 })),
			).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('skips a suite with no associated PR (no query)', async () => {
			expect(
				await handler.handle(
					ctx({
						eventType: 'check_suite',
						action: 'completed',
						workItemId: undefined,
						headSha: 'cafe',
					}),
				),
			).toBeNull();
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
		});

		it('skips a suite with no head SHA (no query)', async () => {
			expect(await handler.handle(ctx({ ...base, headSha: undefined }))).toBeNull();
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
		});
	});

	describe('handle — dedup gate', () => {
		const reviewable = {
			eventType: 'pull_request',
			action: 'opened',
			workItemId: '42',
			headSha: 'abc123',
			isDraft: false,
			isCrossRepo: false,
		} as const;

		it('claims the PR+SHA slot before dispatching', async () => {
			await handler.handle(ctx(reviewable));
			expect(claimReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:42:abc123`, 'pr-review', {
				prNumber: '42',
				headSha: 'abc123',
			});
		});

		it('skips dispatch when the slot is already claimed (or Redis is down)', async () => {
			claimReviewDispatch.mockResolvedValue(false);
			expect(await handler.handle(ctx(reviewable))).toBeNull();
		});

		it('does not claim for an unreviewable event', async () => {
			await handler.handle(ctx({ ...reviewable, isDraft: true }));
			expect(claimReviewDispatch).not.toHaveBeenCalled();
		});
	});
});
