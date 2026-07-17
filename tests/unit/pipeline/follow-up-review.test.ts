import { describe, expect, it, vi } from 'vitest';

const enqueueJob = vi.fn(async (_job: unknown) => 'job-1');
vi.mock('@/queue/producer.js', () => ({
	enqueueJob: (job: unknown) => enqueueJob(job),
}));

import {
	followUpReviewDeliveryId,
	scheduleFollowUpReviewDefault,
} from '@/pipeline/follow-up-review.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

describe('followUpReviewDeliveryId', () => {
	it('is deterministic for the same (project, PR, head)', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).toBe(
			followUpReviewDeliveryId(PROJECT, '42', 'abc123'),
		);
	});

	it('differs when the head SHA changes — a follow-up-follow-up must not collide', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).not.toBe(
			followUpReviewDeliveryId(PROJECT, '42', 'def456'),
		);
	});

	it('differs across PRs', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).not.toBe(
			followUpReviewDeliveryId(PROJECT, '43', 'abc123'),
		);
	});

	it('never contains a colon (BullMQ reserves it for key namespacing)', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).not.toContain(':');
	});
});

describe('scheduleFollowUpReviewDefault', () => {
	it('enqueues a synthetic check_suite completed event carrying the new head, keyed by a deterministic delivery id', async () => {
		enqueueJob.mockClear();

		await scheduleFollowUpReviewDefault({
			project: PROJECT,
			prNumber: '42',
			prBranch: 'issue-42',
			headSha: 'newsha123',
		});

		expect(enqueueJob).toHaveBeenCalledExactlyOnceWith({
			type: 'github',
			projectId: PROJECT.id,
			deliveryId: followUpReviewDeliveryId(PROJECT, '42', 'newsha123'),
			event: {
				eventType: 'check_suite',
				action: 'completed',
				repoFullName: PROJECT.repo,
				workItemId: '42',
				isCommentEvent: false,
				headSha: 'newsha123',
				prBranch: 'issue-42',
			},
		});
	});

	it('re-enqueuing the same (project, PR, head) reuses the same delivery id — the queue absorbs the repeat', async () => {
		enqueueJob.mockClear();

		const input = { project: PROJECT, prNumber: '42', prBranch: 'issue-42', headSha: 'newsha123' };
		await scheduleFollowUpReviewDefault(input);
		await scheduleFollowUpReviewDefault(input);

		const [firstCall, secondCall] = enqueueJob.mock.calls;
		expect((firstCall[0] as { deliveryId: string }).deliveryId).toBe(
			(secondCall[0] as { deliveryId: string }).deliveryId,
		);
	});
});
