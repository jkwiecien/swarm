/**
 * The queued-runs read model — maps a snapshot of pending BullMQ jobs onto the
 * `runs.queued` API shape (issue #234). Pure and Redis-free: the producer
 * (`src/queue/producer.ts`) owns the one Redis-touching `listPendingJobs()`
 * snapshot; everything here just derives, filters, and orders from the
 * already-parsed job data, so it's unit-testable without a queue connection.
 *
 * A `runs` row exists only once the worker picks a job up (`tryCreateRun`,
 * `src/worker/consumer.ts`), so a job still sitting in Redis is otherwise
 * invisible on the dashboard. This module is what makes it visible.
 */

import { z } from 'zod';
import type { SwarmJob } from './jobs.js';

/**
 * Best-effort phase the job will likely dispatch to, derived only from fields
 * already on the parsed event — never a GitHub lookup. `board` covers both
 * Planning and Implementation, which are only distinguished at authoritative
 * dispatch (a fresh GraphQL re-read of the card's Status).
 */
export const QueuedPhaseHintSchema = z.enum([
	'board',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
	'unknown',
]);
export type QueuedPhaseHint = z.infer<typeof QueuedPhaseHintSchema>;

/** Which BullMQ pending set a job was read from. */
export const PendingJobStateSchema = z.enum(['waiting', 'prioritized', 'delayed']);
export type PendingJobState = z.infer<typeof PendingJobStateSchema>;

/**
 * A plain, Redis-free view of one BullMQ job, handed over by the producer's
 * `listPendingJobs()`. Kept separate from BullMQ's own `Job` type so this
 * module never needs to import `bullmq`.
 */
export interface PendingJobSnapshot {
	jobId: string;
	type: SwarmJob['type'];
	state: PendingJobState;
	data: SwarmJob;
	/** `Job.timestamp` — when the job was enqueued, epoch ms. */
	enqueuedAt: number;
	/** `Job.delay` — 0 for a runnable (`waiting`/`prioritized`) job. */
	delayMs: number;
	/** `Job.priority` — BullMQ ranks 0 (unset) as highest. */
	priority: number;
}

/** The `runs.queued` API/UI contract — Zod is the source of truth for this shape. */
export const QueuedRunSchema = z.object({
	jobId: z.string(),
	projectId: z.string(),
	type: z.enum(['github', 'github-projects']),
	state: PendingJobStateSchema,
	phaseHint: QueuedPhaseHintSchema,
	/** `github` jobs only — `owner/repo`. */
	repo: z.string().optional(),
	/** `github` jobs only — the PR/issue number. */
	prNumber: z.string().optional(),
	/** `github-projects` jobs only — the opaque board item node id. */
	workItemNodeId: z.string().optional(),
	/** `github-projects` jobs only — `Issue` | `PullRequest` | `DraftIssue`. */
	contentType: z.string().optional(),
	/** Effective BullMQ priority; 0 is highest. */
	priority: z.number().int().nonnegative(),
	/** ISO 8601 — `Job.timestamp`. */
	enqueuedAt: z.string(),
	/** ISO 8601 — `delayed` jobs only, `enqueuedAt + delayMs`. */
	runsAt: z.string().optional(),
});
export type QueuedRun = z.infer<typeof QueuedRunSchema>;

/**
 * Derive a best-effort phase hint purely from the job's already-parsed event —
 * no GitHub network call. Mirrors (but does not replace) the authoritative
 * trigger-handler rules in `src/triggers/handlers/*.ts`, which re-check state at
 * dispatch time.
 */
export function deriveQueuedPhaseHint(job: SwarmJob): QueuedPhaseHint {
	if (job.type === 'github-projects') return 'board';

	const { event } = job;
	switch (event.eventType) {
		case 'pull_request_review':
			return event.reviewState === 'approved' ? 'review' : 'respond-to-review';
		case 'check_suite':
			return event.checkConclusion === 'failure' ? 'respond-to-ci' : 'review';
		case 'pull_request':
			return event.action === 'closed' && event.merged === true ? 'resolve-conflicts' : 'review';
		default:
			return 'unknown';
	}
}

function toQueuedRun(snapshot: PendingJobSnapshot): QueuedRun {
	const { data } = snapshot;
	const shared = {
		jobId: snapshot.jobId,
		projectId: data.projectId,
		type: data.type,
		state: snapshot.state,
		phaseHint: deriveQueuedPhaseHint(data),
		priority: snapshot.priority,
		enqueuedAt: new Date(snapshot.enqueuedAt).toISOString(),
		...(snapshot.state === 'delayed'
			? { runsAt: new Date(snapshot.enqueuedAt + snapshot.delayMs).toISOString() }
			: {}),
	};

	return QueuedRunSchema.parse(
		data.type === 'github'
			? { ...shared, repo: data.event.repoFullName, prNumber: data.event.workItemId }
			: { ...shared, workItemNodeId: data.event.itemNodeId, contentType: data.event.contentType },
	);
}

/**
 * Order to mirror BullMQ's own dispatch intent: runnable (`waiting`/
 * `prioritized`) before `delayed`; priority ascending (BullMQ ranks 0/unset
 * highest); then FIFO within the same priority — enqueue time for runnable
 * jobs, scheduled run time for delayed ones.
 */
export function sortQueuedRuns(items: QueuedRun[]): QueuedRun[] {
	const stateRank = (state: PendingJobState): number => (state === 'delayed' ? 1 : 0);
	const timeRank = (item: QueuedRun): number =>
		Date.parse(item.state === 'delayed' ? (item.runsAt ?? item.enqueuedAt) : item.enqueuedAt);

	return [...items].sort((a, b) => {
		const byState = stateRank(a.state) - stateRank(b.state);
		if (byState !== 0) return byState;
		if (a.priority !== b.priority) return a.priority - b.priority;
		return timeRank(a) - timeRank(b);
	});
}

/**
 * The read model's entry point: filter out jobs already tracked as a `deferred`
 * run (`data.runId` set — the dedup invariant), map the rest to the API shape,
 * and order them to mirror dispatch.
 */
export function toQueuedRuns(snapshots: PendingJobSnapshot[]): QueuedRun[] {
	return sortQueuedRuns(
		snapshots.filter((snapshot) => snapshot.data.runId === undefined).map(toQueuedRun),
	);
}
