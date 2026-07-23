import { describe, expect, it } from 'vitest';
import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
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

/** A waiting dispatch row, shaped like `listWaitingDispatches()` returns them. */
function makeDispatch(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'p1',
		taskId: null,
		phase: null,
		state: 'pending',
		waitReason: null,
		outcome: null,
		dedupKey: null,
		coalesceKey: null,
		continuation: false,
		priority: 0,
		attempt: 0,
		wakeSeq: 0,
		// In the past relative to the test run, so a plain pending row is
		// eligible now (`waiting`), not `delayed`.
		availableAt: new Date(1_700_000_000_000),
		jobPayload: createMockGitHubWebhookJob(),
		runId: null,
		selectedWorkerId: null,
		workerSessionId: null,
		workerFencingToken: null,
		leaseOwner: null,
		leaseExpiresAt: null,
		lastError: null,
		source: 'webhook',
		createdAt: new Date(1_700_000_000_000),
		updatedAt: new Date(1_700_000_000_000),
		completedAt: null,
		...overrides,
	};
}

/** A durable merge intent payload (issue #292). */
const MERGE_JOB = {
	type: 'merge-automation' as const,
	projectId: 'p1',
	reviewRunId: 'run-1',
	repo: 'jkwiecien/swarm',
	prNumber: '17',
	approvedHeadSha: 'deadbeef',
};

describe('deriveQueuedPhaseHint', () => {
	it('hints board for every github-projects job', () => {
		expect(deriveQueuedPhaseHint(createMockGitHubProjectsWebhookJob())).toBe('board');
	});

	it('hints merge-automation for a merge-automation job', () => {
		expect(deriveQueuedPhaseHint(MERGE_JOB)).toBe('merge-automation');
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
	it('includes a retry-scheduled dispatch (linked run) as a delayed queue item', () => {
		const deferred = makeDispatch({
			id: 'deferred',
			state: 'retry-scheduled',
			waitReason: 'rate-limit',
			runId: 'run-1',
			attempt: 2,
			availableAt: new Date(1_700_000_030_000),
			jobPayload: createMockGitHubWebhookJob({ runId: 'run-1' }),
		});
		const fresh = makeDispatch({ id: 'fresh' });

		const result = toQueuedRuns([deferred, fresh]);

		// Canonical queue completeness (issue #284): nothing pending is invisible —
		// a scheduled retry shows with its run link, wait reason and schedule.
		expect(result.map((r) => r.jobId)).toEqual(['fresh', 'deferred']);
		const deferredItem = result[1];
		expect(deferredItem).toMatchObject({
			state: 'delayed',
			waitReason: 'rate-limit',
			runId: 'run-1',
			attempt: 2,
			runsAt: new Date(1_700_000_030_000).toISOString(),
		});
	});

	it('maps a capacity-blocked dispatch to the blocked state with its wait reason', () => {
		const [item] = toQueuedRuns([
			makeDispatch({ waitReason: 'project-capacity', continuation: true }),
		]);
		expect(item).toMatchObject({ state: 'blocked', waitReason: 'project-capacity' });
		expect(item.runsAt).toBeUndefined();
	});

	it('carries the dispatch continuation flag and exact availability timestamp through', () => {
		const [continuationItem] = toQueuedRuns([
			makeDispatch({ continuation: true, availableAt: new Date(1_700_000_030_000) }),
		]);
		expect(continuationItem.continuation).toBe(true);
		expect(continuationItem.availableAt).toBe(new Date(1_700_000_030_000).toISOString());

		const [ordinaryItem] = toQueuedRuns([makeDispatch()]);
		expect(ordinaryItem.continuation).toBe(false);
	});

	it('maps a github job to repo + prNumber, no board fields', () => {
		const job = createMockGitHubWebhookJob({
			event: {
				...createMockGitHubWebhookJob().event,
				repoFullName: 'jkwiecien/swarm',
				workItemId: '42',
			},
		});

		const [item] = toQueuedRuns([makeDispatch({ jobPayload: job })]);

		expect(item).toMatchObject({
			type: 'github',
			repo: 'jkwiecien/swarm',
			prNumber: '42',
			state: 'waiting',
		});
		expect(item.workItemNodeId).toBeUndefined();
		expect(item.contentType).toBeUndefined();
	});

	it('maps a merge-automation dispatch to repo + prNumber with its run link (issue #292)', () => {
		const [item] = toQueuedRuns([
			makeDispatch({
				jobPayload: MERGE_JOB,
				phase: 'merge-automation',
				state: 'retry-scheduled',
				waitReason: 'recheck',
				runId: 'run-1',
				attempt: 3,
				availableAt: new Date(1_700_000_030_000),
			}),
		]);

		expect(item).toMatchObject({
			type: 'merge-automation',
			phaseHint: 'merge-automation',
			repo: 'jkwiecien/swarm',
			prNumber: '17',
			state: 'delayed',
			waitReason: 'recheck',
			runId: 'run-1',
			attempt: 3,
		});
		expect(item.workItemNodeId).toBeUndefined();
	});

	it('maps a github-projects job to workItemNodeId + contentType, no repo fields', () => {
		const job = createMockGitHubProjectsWebhookJob({
			event: {
				...createMockGitHubProjectsWebhookJob().event,
				itemNodeId: 'PVTI_abc',
				contentType: 'Issue',
			},
		});

		const [item] = toQueuedRuns([makeDispatch({ jobPayload: job, priority: 10 })]);

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

	it('prefers the worker-resolved phase over the event-derived hint', () => {
		const [item] = toQueuedRuns([
			makeDispatch({ phase: 'implementation', jobPayload: createMockGitHubProjectsWebhookJob() }),
		]);
		expect(item.phaseHint).toBe('implementation');
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

		const [item] = toQueuedRuns([makeDispatch({ jobPayload: job })]);

		expect(item.reviewGate).toEqual({
			sourceEvent: 'check_suite',
			sourceAction: 'completed',
			headSha: 'abc123',
		});
	});

	it('omits reviewGate for a job that is not a review-gate input', () => {
		const [item] = toQueuedRuns([
			makeDispatch({ jobPayload: createMockGitHubProjectsWebhookJob() }),
		]);
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
			makeDispatch({ id: 'dispatch-followup', jobPayload: followUp }),
			makeDispatch({ id: 'dispatch-synchronize', jobPayload: synchronize }),
		]);

		expect(items).toHaveLength(2);
		expect(items.every((item) => item.phaseHint === 'review')).toBe(true);
		expect(items.map((item) => item.reviewGate?.headSha)).toEqual(['def456', 'def456']);
		expect(items.map((item) => item.reviewGate?.sourceEvent)).toEqual([
			'check_suite',
			'pull_request',
		]);
	});

	it('computes runsAt only for a scheduled (delayed) dispatch', () => {
		const [waitingItem] = toQueuedRuns([makeDispatch()]);
		expect(waitingItem.runsAt).toBeUndefined();

		const [delayedItem] = toQueuedRuns([
			makeDispatch({
				state: 'retry-scheduled',
				waitReason: 'timeout',
				availableAt: new Date(1_700_000_030_000),
			}),
		]);
		expect(delayedItem.state).toBe('delayed');
		expect(delayedItem.runsAt).toBe(new Date(1_700_000_030_000).toISOString());
	});

	it('treats a pending dispatch with a future availableAt as delayed', () => {
		const future = new Date(Date.now() + 60_000);
		const [item] = toQueuedRuns([makeDispatch({ waitReason: 'recheck', availableAt: future })]);
		expect(item.state).toBe('delayed');
		expect(item.runsAt).toBe(future.toISOString());
	});

	it('carries the effective priority through', () => {
		const [item] = toQueuedRuns([
			makeDispatch({ priority: 10, jobPayload: createMockGitHubProjectsWebhookJob() }),
		]);
		expect(item.priority).toBe(10);
	});

	it('skips a dispatch whose stored payload no longer parses instead of breaking the list', () => {
		const items = toQueuedRuns([
			makeDispatch({ id: 'broken', jobPayload: { nonsense: true } as never }),
			makeDispatch({ id: 'good' }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['good']);
	});

	it('round-trips a representative object through QueuedRunSchema', () => {
		const [item] = toQueuedRuns([makeDispatch()]);
		expect(() => QueuedRunSchema.parse(item)).not.toThrow();
	});
});

describe('sortQueuedRuns', () => {
	it('orders runnable dispatches before blocked, before delayed', () => {
		const items = toQueuedRuns([
			makeDispatch({
				id: 'delayed',
				state: 'retry-scheduled',
				waitReason: 'rate-limit',
				availableAt: new Date(1_700_000_030_000),
			}),
			makeDispatch({ id: 'blocked', waitReason: 'project-capacity' }),
			makeDispatch({ id: 'waiting', createdAt: new Date(1_700_000_005_000) }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['waiting', 'blocked', 'delayed']);
	});

	// Regression (issue #374): the blocked bucket must mirror
	// selectNextCapacityDispatch (continuation desc, availableAt asc), NOT the
	// generic priority/FIFO ordering the other buckets use — otherwise the
	// dashboard's displayed order diverges from the scheduler's real wake order.
	it('orders a blocked continuation ahead of higher-priority, earlier ordinary blocked work', () => {
		const items = toQueuedRuns([
			makeDispatch({
				id: 'ordinary',
				waitReason: 'project-capacity',
				continuation: false,
				priority: 0,
				availableAt: new Date(1_700_000_010_000),
				createdAt: new Date(1_700_000_010_000),
			}),
			makeDispatch({
				id: 'continuation',
				waitReason: 'project-capacity',
				continuation: true,
				priority: 10,
				availableAt: new Date(1_700_000_050_000),
				createdAt: new Date(1_700_000_050_000),
			}),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['continuation', 'ordinary']);
	});

	it('orders blocked work purely by availableAt FIFO when prioritizeContinuations is false', () => {
		const items = toQueuedRuns(
			[
				makeDispatch({
					id: 'ordinary',
					projectId: 'p1',
					waitReason: 'project-capacity',
					continuation: false,
					availableAt: new Date(1_700_000_010_000),
				}),
				makeDispatch({
					id: 'continuation',
					projectId: 'p1',
					waitReason: 'project-capacity',
					continuation: true,
					availableAt: new Date(1_700_000_050_000),
				}),
			],
			{ p1: false },
		);
		expect(items.map((i) => i.jobId)).toEqual(['ordinary', 'continuation']);

		const itemsReverse = toQueuedRuns(
			[
				makeDispatch({
					id: 'ordinary',
					projectId: 'p1',
					waitReason: 'project-capacity',
					continuation: false,
					availableAt: new Date(1_700_000_050_000),
				}),
				makeDispatch({
					id: 'continuation',
					projectId: 'p1',
					waitReason: 'project-capacity',
					continuation: true,
					availableAt: new Date(1_700_000_010_000),
				}),
			],
			{ p1: false },
		);
		expect(itemsReverse.map((i) => i.jobId)).toEqual(['continuation', 'ordinary']);
	});

	it('orders blocked rows of the same continuation class by availableAt, not priority or creation time', () => {
		const items = toQueuedRuns([
			makeDispatch({
				id: 'later-available',
				waitReason: 'project-capacity',
				continuation: true,
				priority: 0,
				availableAt: new Date(1_700_000_050_000),
				createdAt: new Date(1_700_000_000_000),
			}),
			makeDispatch({
				id: 'earlier-available',
				waitReason: 'project-capacity',
				continuation: true,
				priority: 10,
				availableAt: new Date(1_700_000_030_000),
				createdAt: new Date(1_700_000_060_000),
			}),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['earlier-available', 'later-available']);
	});

	it('orders priority-0 github ahead of priority-10 github-projects within the runnable group', () => {
		const items = toQueuedRuns([
			makeDispatch({
				id: 'board',
				priority: 10,
				jobPayload: createMockGitHubProjectsWebhookJob(),
				createdAt: new Date(1_700_000_000_000),
			}),
			makeDispatch({ id: 'review', priority: 0, createdAt: new Date(1_700_000_005_000) }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['review', 'board']);
	});

	it('breaks ties within the same priority by FIFO creation time', () => {
		const items = toQueuedRuns([
			makeDispatch({ id: 'later', createdAt: new Date(1_700_000_002_000) }),
			makeDispatch({ id: 'earlier', createdAt: new Date(1_700_000_001_000) }),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['earlier', 'later']);
	});

	it('orders delayed dispatches by scheduled run time (runsAt), not creation time', () => {
		const items = toQueuedRuns([
			makeDispatch({
				id: 'runs-later',
				state: 'retry-scheduled',
				waitReason: 'timeout',
				availableAt: new Date(1_700_000_050_000),
				createdAt: new Date(1_700_000_000_000),
			}),
			makeDispatch({
				id: 'runs-sooner',
				state: 'retry-scheduled',
				waitReason: 'timeout',
				availableAt: new Date(1_700_000_030_000),
				createdAt: new Date(1_700_000_005_000),
			}),
		]);
		expect(items.map((i) => i.jobId)).toEqual(['runs-sooner', 'runs-later']);
	});

	it('does not mutate its input array', () => {
		const items = toQueuedRuns([
			makeDispatch({ id: 'b', createdAt: new Date(1_700_000_002_000) }),
			makeDispatch({ id: 'a', createdAt: new Date(1_700_000_001_000) }),
		]);
		const copy = [...items];
		sortQueuedRuns(items);
		expect(items).toEqual(copy);
	});
});
