import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger.js';
import { mergeAfterReviewIfEligible } from '@/pipeline/merge-after-review.js';
import type { MergePullRequestOutcome } from '@/scm/merge.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

function baseOptions(overrides: Partial<Parameters<typeof mergeAfterReviewIfEligible>[0]> = {}) {
	return {
		enabled: true,
		eligible: true,
		mergePullRequest: vi.fn<() => Promise<MergePullRequestOutcome>>(),
		project: createMockProjectConfig(),
		prNumber: '99',
		taskId: 'review-20',
		phase: 'Review',
		...overrides,
	};
}

describe('mergeAfterReviewIfEligible', () => {
	it('never calls the provider when merge automation is disabled', async () => {
		const options = baseOptions({ enabled: false });
		const result = await mergeAfterReviewIfEligible(options);
		expect(result).toBeUndefined();
		expect(options.mergePullRequest).not.toHaveBeenCalled();
	});

	it('never calls the provider when the verdict is not eligible (e.g. request-changes)', async () => {
		const options = baseOptions({ eligible: false });
		const result = await mergeAfterReviewIfEligible(options);
		expect(result).toBeUndefined();
		expect(options.mergePullRequest).not.toHaveBeenCalled();
	});

	it('returns a merged outcome and logs at info level', async () => {
		const info = vi.spyOn(logger, 'info');
		const warn = vi.spyOn(logger, 'warn');
		const outcome: MergePullRequestOutcome = { status: 'merged', message: 'merged via direct API' };
		const options = baseOptions({ mergePullRequest: vi.fn(async () => outcome) });

		const result = await mergeAfterReviewIfEligible(options);

		expect(result).toEqual(outcome);
		expect(options.mergePullRequest).toHaveBeenCalledWith(options.project, 99);
		expect(info).toHaveBeenCalledWith(
			'Review merged pull request',
			expect.objectContaining({ taskId: 'review-20', prNumber: '99' }),
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		['not-ready', { status: 'not-ready', message: 'pending required checks' }],
		['policy-blocked', { status: 'policy-blocked', message: 'branch protection forbids merge' }],
		['unsupported', { status: 'unsupported', message: 'repository requires a merge queue' }],
		['provider-error', { status: 'provider-error', message: '502 Bad Gateway' }],
	] satisfies Array<
		[string, MergePullRequestOutcome]
	>)('surfaces a %s outcome without throwing, logged as a warning', async (_label, outcome) => {
		const warn = vi.spyOn(logger, 'warn');
		const options = baseOptions({ mergePullRequest: vi.fn(async () => outcome) });

		const result = await mergeAfterReviewIfEligible(options);

		expect(result).toEqual(outcome);
		expect(warn).toHaveBeenCalledWith(
			'Review did not merge pull request',
			expect.objectContaining({ status: outcome.status, reason: outcome.message }),
		);
	});

	it('normalizes an unexpected thrown rejection to a provider-error outcome', async () => {
		const warn = vi.spyOn(logger, 'warn');
		const options = baseOptions({
			mergePullRequest: vi.fn(async () => {
				throw new Error('adapter crashed');
			}),
		});

		const result = await mergeAfterReviewIfEligible(options);

		expect(result).toEqual({ status: 'provider-error', message: 'adapter crashed' });
		expect(warn).toHaveBeenCalledWith(
			'Review did not merge pull request',
			expect.objectContaining({ status: 'provider-error', reason: 'adapter crashed' }),
		);
	});
});
