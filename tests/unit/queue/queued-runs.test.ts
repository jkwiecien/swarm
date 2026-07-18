import { describe, expect, it } from 'vitest';
import type { PendingJobSnapshot } from '@/queue/queued-runs.js';
import {
	deriveQueuedPhaseHint,
	deriveReviewGate,
	QueuedRunSchema,
	sortQueuedRuns,
	toQueuedRuns,
} from '@/queue/queued-runs.js';
import {
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
} from '../../helpers/factories.js';

function makeSnapshot(overrides: Partial<PendingJobSnapshot> = {}): PendingJobSnapshot {
	return {
		jobId: 'job-1',
		type: 'github',
		state: 'waiting',
		data: createMockGitHubWebhookJob(),
		enqueuedAt: 1_700_000_000_000,
		delayMs: 0,
		priority: 0,
		...overrides,
	};
}

describe('deriveQueuedPhaseHint', () => {
	it('hints board for every github-projects job', () => {
		expect(deriveQueuedPhaseHint(createMockGitHubProjectsWebhookJob())).toBe('board');
	});

	it('hints respond-to-review for a non-approved pull_request_review', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'pull_request_review',
				reviewState: 'changes_requested',
			},
		});
		expect(deriveQueuedPhaseHint(job)).toBe('respond-to-review');
	});

	it('hints review for an approved pull_request_review', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'pull_request_review',
				reviewState: 'approved',
			},
		});
		expect(deriveQueuedPhaseHint(job)).toBe('review');
	});

	it('hints respond-to-ci for a failed check_suite', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'check_suite',
				checkConclusion: 'failure',
			},
		});
		expect(deriveQueuedPhaseHint(job)).toBe('respond-to-ci');
	});

	it('hints review for a successful check_suite', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'check_suite',
				checkConclusion: 'success',
			},
		});
		expect(deriveQueuedPhaseHint(job)).toBe('review');
	});

	it('hints resolve-conflicts for a merged, closed pull_request', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'pull_request',
				action: 'closed',
				merged: true,
			},
		});
		expect(deriveQueuedPhaseHint(job)).toBe('resolve-conflicts');
	});

	it('hints review for an opened pull_request', () => {
		const job = createMockGitHubWebhookJob({
			event: { ...createMockGitHubWebhookJob().event, eventType: 'pull_request', action: 'opened' },
		});
		expect(deriveQueuedPhaseHint(job)).toBe('review');
	});

	it('hints unknown for an issue_comment', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'issue_comment',
				isCommentEvent: true,
			},
		});
		expect(deriveQueuedPhaseHint(job)).toBe('unknown');
	});
});

describe('deriveReviewGate', () => {
	it('classifies a completed check_suite carrying a PR number and head SHA', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'check_suite',
				action: 'completed',
				workItemId: '42',
				headSha: 'abc123',
			},
		});
		expect(deriveReviewGate(job)).toEqual({
			sourceEvent: 'check_suite',
			sourceAction: 'completed',
			headSha: 'abc123',
		});
	});

	it('classifies a synchronize pull_request event and carries its recheckAttempt', () => {
		const job = createMockGitHubWebhookJob({
			recheckAttempt: 2,
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'pull_request',
				action: 'synchronize',
				workItemId: '42',
				headSha: 'abc123',
			},
		});
		expect(deriveReviewGate(job)).toEqual({
			sourceEvent: 'pull_request',
			sourceAction: 'synchronize',
			headSha: 'abc123',
			recheckAttempt: 2,
		});
	});

	it('is undefined for a github-projects job', () => {
		expect(deriveReviewGate(createMockGitHubProjectsWebhookJob())).toBeUndefined();
	});

	it('is undefined for a non-review-hinted github job (e.g. a failed check_suite)', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'check_suite',
				checkConclusion: 'failure',
				workItemId: '42',
				headSha: 'abc123',
			},
		});
		expect(deriveReviewGate(job)).toBeUndefined();
	});

	it('is undefined when the event carries no head SHA', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'pull_request',
				action: 'opened',
				workItemId: '42',
				headSha: undefined,
			},
		});
		expect(deriveReviewGate(job)).toBeUndefined();
	});

	it('is undefined when the event carries no PR number', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'check_suite',
				action: 'completed',
				workItemId: undefined,
				headSha: 'abc123',
			},
		});
		expect(deriveReviewGate(job)).toBeUndefined();
	});
});

describe('toQueuedRuns', () => {
	it('excludes a job whose data carries a runId (already a deferred run)', () => {
		const deferred = createMockGitHubWebhookJob({ runId: 'run-1' });
		const fresh = createMockGitHubWebhookJob({ deliveryId: 'delivery-fresh' });

		const result = toQueuedRuns([
			makeSnapshot({ jobId: 'deferred', data: deferred }),
			makeSnapshot({ jobId: 'fresh', data: fresh }),
		]);

		expect(result.map((r) => r.jobId)).toEqual(['fresh']);
	});

	it('maps a github job to repo + prNumber, no board fields', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				repoFullName: 'jkwiecien/swarm',
				workItemId: '42',
			},
		});

		const [item] = toQueuedRuns([makeSnapshot({ data: job, state: 'waiting' })]);

		expect(item).toMatchObject({
			type: 'github',
			repo: 'jkwiecien/swarm',
			prNumber: '42',
			state: 'waiting',
		});
		expect(item.workItemNodeId).toBeUndefined();
		expect(item.contentType).toBeUndefined();
	});

	it('maps a github-projects job to workItemNodeId + contentType, no repo fields', () => {
		const job = createMockGitHubProjectsWebhookJob({
			event: {
				...createMockGitHubProjectsWebhookJob().event,
				itemNodeId: 'PVTI_abc',
				contentType: 'Issue',
			},
		});

		const [item] = toQueuedRuns([
			makeSnapshot({ data: job, type: 'github-projects', state: 'prioritized', priority: 10 }),
		]);

		expect(item).toMatchObject({
			type: 'github-projects',
			workItemNodeId: 'PVTI_abc',
			contentType: 'Issue',
			state: 'prioritized',
			priority: 10,
		});
		expect(item.repo).toBeUndefined();
		expect(item.prNumber).toBeUndefined();
	});

	it('carries reviewGate metadata through for a review-hinted github job', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'check_suite',
				action: 'completed',
				workItemId: '42',
				headSha: 'abc123',
			},
		});

		const [item] = toQueuedRuns([makeSnapshot({ data: job })]);

		expect(item.reviewGate).toEqual({
			sourceEvent: 'check_suite',
			sourceAction: 'completed',
			headSha: 'abc123',
		});
	});

	it('omits reviewGate for a job that is not a review-gate input', () => {
		const [item] = toQueuedRuns([makeSnapshot({ data: createMockGitHubProjectsWebhookJob() })]);
		expect(item.reviewGate).toBeUndefined();
	});

	// Regression (issue #275): a fixed Respond-to-review push enqueues both a
	// synthetic `check_suite` `completed` follow-up (`src/pipeline/follow-up-review.ts`)
	// and GitHub delivers its own `pull_request` `synchronize` webhook for that
	// same push — two raw events, same PR + new head SHA. The dispatch dedup
	// folds these into at most one Review run; this asserts the read model
	// exposes matching reviewGate identity so the UI can group them into one row.
	it('exposes matching reviewGate identity for a synthetic follow-up and the real pull_request:synchronize webhook', () => {
		const followUp = createMockGitHubWebhookJob({
			deliveryId: 'respond-to-review-followup-jkwiecien-swarm-42-def456',
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'check_suite',
				action: 'completed',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '42',
				headSha: 'def456',
			},
		});
		const synchronize = createMockGitHubWebhookJob({
			deliveryId: 'delivery-real-webhook',
			event: {
				...createMockGitHubWebhookJob().event,
				eventType: 'pull_request',
				action: 'synchronize',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '42',
				headSha: 'def456',
			},
		});

		const items = toQueuedRuns([
			makeSnapshot({ jobId: 'job-followup', data: followUp }),
			makeSnapshot({ jobId: 'job-synchronize', data: synchronize }),
		]);

		expect(items).toHaveLength(2);
		expect(items.every((item) => item.phaseHint === 'review')).toBe(true);
		expect(items.map((item) => item.reviewGate?.headSha)).toEqual(['def456', 'def456']);
		expect(items.map((item) => item.reviewGate?.sourceEvent)).toEqual([
			'check_suite',
			'pull_request',
		]);
	});

	it('computes runsAt only for a delayed job', () => {
		const [waitingItem] = toQueuedRuns([
			makeSnapshot({ state: 'waiting', enqueuedAt: 1_700_000_000_000, delayMs: 0 }),
		]);
		expect(waitingItem.runsAt).toBeUndefined();

		const [delayedItem] = toQueuedRuns([
			makeSnapshot({ state: 'delayed', enqueuedAt: 1_700_000_000_000, delayMs: 30_000 }),
		]);
		expect(delayedItem.runsAt).toBe(new Date(1_700_000_030_000).toISOString());
	});

	it('prioritizes the runsAt property on PendingJobSnapshot for the computed runsAt', () => {
		const [delayedItem] = toQueuedRuns([
			makeSnapshot({
				state: 'delayed',
				enqueuedAt: 1_700_000_000_000,
				delayMs: 30_000,
				runsAt: 1_700_000_100_000,
			}),
		]);
		expect(delayedItem.runsAt).toBe(new Date(1_700_000_100_000).toISOString());
	});

	it('carries the effective priority through', () => {
		const [item] = toQueuedRuns([makeSnapshot({ priority: 10 })]);
		expect(item.priority).toBe(10);
	});

	it('round-trips a representative object through QueuedRunSchema', () => {
		const [item] = toQueuedRuns([makeSnapshot()]);
		expect(() => QueuedRunSchema.parse(item)).not.toThrow();
	});
});

describe('sortQueuedRuns', () => {
	it('orders runnable jobs before delayed jobs', () => {
		const items = toQueuedRuns([
			makeSnapshot({ jobId: 'delayed', state: 'delayed', enqueuedAt: 0, delayMs: 1000 }),
			makeSnapshot({ jobId: 'waiting', state: 'waiting', enqueuedAt: 5000 }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['waiting', 'delayed']);
	});

	it('orders priority-0 github ahead of priority-10 github-projects within the runnable group', () => {
		const items = toQueuedRuns([
			makeSnapshot({
				jobId: 'board',
				type: 'github-projects',
				state: 'prioritized',
				priority: 10,
				data: createMockGitHubProjectsWebhookJob(),
				enqueuedAt: 0,
			}),
			makeSnapshot({ jobId: 'review', state: 'waiting', priority: 0, enqueuedAt: 5000 }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['review', 'board']);
	});

	it('breaks ties within the same priority by FIFO enqueuedAt', () => {
		const items = toQueuedRuns([
			makeSnapshot({ jobId: 'later', enqueuedAt: 2000 }),
			makeSnapshot({ jobId: 'earlier', enqueuedAt: 1000 }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['earlier', 'later']);
	});

	it('orders delayed jobs by scheduled run time (runsAt), not raw enqueuedAt', () => {
		const items = toQueuedRuns([
			// Enqueued later but scheduled to run sooner.
			makeSnapshot({ jobId: 'runs-sooner', state: 'delayed', enqueuedAt: 5000, delayMs: 0 }),
			makeSnapshot({ jobId: 'runs-later', state: 'delayed', enqueuedAt: 0, delayMs: 10_000 }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['runs-sooner', 'runs-later']);
	});

	it('does not mutate its input array', () => {
		const items = toQueuedRuns([
			makeSnapshot({ jobId: 'b', enqueuedAt: 2000 }),
			makeSnapshot({ jobId: 'a', enqueuedAt: 1000 }),
		]);
		const copy = [...items];
		sortQueuedRuns(items);
		expect(items).toEqual(copy);
	});
});
