/**
 * The queued-runs read model — maps canonical *dispatch* records onto the
 * `runs.queued` API shape (issues #234, #284). Pure and connection-free: the
 * repository (`src/db/repositories/dispatchesRepository.ts`) owns the one
 * DB-touching `listWaitingDispatches()` query; everything here just derives,
 * maps, and orders from the already-loaded rows, so it's unit-testable on its
 * own.
 *
 * Before issue #284 this read an incomplete BullMQ snapshot, which could not
 * see capacity-blocked work and disagreed with the `runs` table about retries.
 * The dispatch table is the single source of truth for pending work, so every
 * pending or retry-scheduled unit of work is visible here — with its state,
 * wait reason, priority, and scheduled time — by construction.
 */

import { z } from 'zod';
import type { DispatchRow } from '../db/repositories/dispatchesRepository.js';
import type { SwarmJob } from './jobs.js';

/**
 * Best-effort phase the dispatch will likely run, derived from the resolved
 * phase when the worker recorded one, else from fields already on the parsed
 * event — never a GitHub lookup. `board` covers both Planning and
 * Implementation, which are only distinguished at authoritative dispatch (a
 * fresh GraphQL re-read of the card's Status).
 */
export const QueuedPhaseHintSchema = z.enum([
	'board',
	'planning',
	'implementation',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
	'merge-automation',
	'unknown',
]);
export type QueuedPhaseHint = z.infer<typeof QueuedPhaseHintSchema>;

/**
 * The queue-facing view of a dispatch's state: `waiting`/`prioritized` for an
 * eligible-now pending dispatch (by queue priority), `blocked` for one waiting
 * on project capacity (woken by a freed slot, not a timer), and `delayed` for
 * a scheduled retry.
 */
export const PendingJobStateSchema = z.enum(['waiting', 'prioritized', 'delayed', 'blocked']);
export type PendingJobState = z.infer<typeof PendingJobStateSchema>;

/** Why a waiting dispatch isn't running — mirrors `DispatchWaitReason`. */
export const QueuedWaitReasonSchema = z.enum([
	'project-capacity',
	'rate-limit',
	'agent-capacity',
	'timeout',
	'worker-shutdown',
	'delivery',
	'worktree-exists',
	'stalled',
	'recheck',
	'manual-retry',
	'recovered',
]);
export type QueuedWaitReason = z.infer<typeof QueuedWaitReasonSchema>;

/** The raw GitHub lifecycle event a review-gate job's metadata was derived from. */
export const ReviewGateSourceEventSchema = z.enum(['pull_request', 'check_suite']);
export type ReviewGateSourceEvent = z.infer<typeof ReviewGateSourceEventSchema>;

/**
 * Diagnostic metadata for a dispatch whose best-effort {@link QueuedPhaseHint}
 * is `review` (issue #275): a raw `pull_request`/`check_suite` lifecycle event
 * that *enters* the `pr-review` trigger handler as a gate input, not proof that
 * a Review agent is already queued — the handler's own PR+SHA dispatch dedup
 * (`review-dispatch-dedup.ts`) folds every such event for the same head SHA
 * into at most one Review run. The UI groups rows carrying the same
 * `(project, repo, PR, headSha)` using this field instead of rendering one
 * `Review queued` row per source event.
 */
export const QueuedReviewGateSchema = z.object({
	sourceEvent: ReviewGateSourceEventSchema,
	/** The webhook `action` on the source event (e.g. `opened`, `synchronize`, `completed`). */
	sourceAction: z.string().optional(),
	/** The PR head commit SHA this event evaluates — the review dispatch dedup key. */
	headSha: z.string(),
	/** Deferred check-suite recheck attempt count, when this job is a coalesced recheck. */
	recheckAttempt: z.number().int().nonnegative().optional(),
});
export type QueuedReviewGate = z.infer<typeof QueuedReviewGateSchema>;

/** The `runs.queued` API/UI contract — Zod is the source of truth for this shape. */
export const QueuedRunSchema = z.object({
	/** The canonical dispatch id — the handle Put back / cancel operate on. */
	jobId: z.string(),
	projectId: z.string(),
	type: z.enum(['github', 'github-projects', 'merge-automation']),
	state: PendingJobStateSchema,
	phaseHint: QueuedPhaseHintSchema,
	/** Why this dispatch is waiting, when it recorded a reason. */
	waitReason: QueuedWaitReasonSchema.optional(),
	/** The `runs` row this dispatch retries, when one exists (deferred runs). */
	runId: z.string().optional(),
	/** Deferred-retry attempt counter. */
	attempt: z.number().int().nonnegative().optional(),
	/** `github` and `merge-automation` jobs only — `owner/repo`. */
	repo: z.string().optional(),
	/** `github` and `merge-automation` jobs only — the PR/issue number. */
	prNumber: z.string().optional(),
	/** `github-projects` jobs only — the opaque board item node id. */
	workItemNodeId: z.string().optional(),
	/** `github-projects` jobs only — `Issue` | `PullRequest` | `DraftIssue`. */
	contentType: z.string().optional(),
	/** Resolved backing Issue/PR title for a board job, when the PM provider can read it. */
	workItemTitle: z.string().optional(),
	/** Resolved backing Issue/PR URL for a board job, when the PM provider can read it. */
	workItemUrl: z.string().optional(),
	/** Effective queue priority; 0 is highest. */
	priority: z.number().int().nonnegative(),
	/** ISO 8601 — when the dispatch was created. */
	enqueuedAt: z.string(),
	/** ISO 8601 — `delayed` dispatches only, scheduled run time. */
	runsAt: z.string().optional(),
	/**
	 * Present only for a `review`-hinted `github` job carrying the PR number and
	 * head SHA needed to classify it safely (see {@link QueuedReviewGateSchema}).
	 */
	reviewGate: QueuedReviewGateSchema.optional(),
});
export type QueuedRun = z.infer<typeof QueuedRunSchema>;

/**
 * Derive a best-effort phase hint purely from the job's already-parsed event —
 * no GitHub network call. Mirrors (but does not replace) the authoritative
 * trigger-handler rules in `src/triggers/handlers/*.ts`, which re-check state
 * at dispatch time.
 */
export function deriveQueuedPhaseHint(job: SwarmJob): QueuedPhaseHint {
	if (job.type === 'github-projects') return 'board';
	if (job.type === 'merge-automation') return 'merge-automation';

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

/**
 * Extract review-gate diagnostic metadata (see {@link QueuedReviewGateSchema})
 * for a `github` job whose best-effort phase hint is `review` — `undefined`
 * for every other job, and for a review-hinting event missing the PR number or
 * head SHA a safe grouping needs. Never calls GitHub — derived purely from the
 * job's already-parsed event, same as {@link deriveQueuedPhaseHint}.
 */
export function deriveReviewGate(job: SwarmJob): QueuedReviewGate | undefined {
	if (job.type !== 'github') return undefined;
	const { event } = job;
	if (event.eventType !== 'pull_request' && event.eventType !== 'check_suite') return undefined;
	if (deriveQueuedPhaseHint(job) !== 'review') return undefined;
	if (!event.workItemId || !event.headSha) return undefined;

	return QueuedReviewGateSchema.parse({
		sourceEvent: event.eventType,
		sourceAction: event.action,
		headSha: event.headSha,
		recheckAttempt: job.recheckAttempt,
	});
}

/** The queue-facing state of a waiting dispatch (see {@link PendingJobStateSchema}). */
export function deriveQueuedState(dispatch: DispatchRow): PendingJobState {
	if (dispatch.state === 'retry-scheduled') return 'delayed';
	if (dispatch.waitReason === 'project-capacity') return 'blocked';
	if (dispatch.availableAt.getTime() > Date.now()) return 'delayed';
	return dispatch.priority > 0 ? 'prioritized' : 'waiting';
}

function toQueuedRun(dispatch: DispatchRow): QueuedRun {
	const data = dispatch.jobPayload;
	const state = deriveQueuedState(dispatch);
	const reviewGate = deriveReviewGate(data);
	// A worker-resolved phase is authoritative; the event-derived hint covers
	// dispatches never claimed yet.
	const phaseHint = QueuedPhaseHintSchema.safeParse(dispatch.phase);
	const shared = {
		jobId: dispatch.id,
		projectId: dispatch.projectId,
		type: data.type,
		state,
		phaseHint: phaseHint.success ? phaseHint.data : deriveQueuedPhaseHint(data),
		waitReason: dispatch.waitReason ?? undefined,
		runId: dispatch.runId ?? undefined,
		attempt: dispatch.attempt,
		priority: dispatch.priority,
		enqueuedAt: dispatch.createdAt.toISOString(),
		...(state === 'delayed' ? { runsAt: dispatch.availableAt.toISOString() } : {}),
		...(reviewGate ? { reviewGate } : {}),
	};

	return QueuedRunSchema.parse(
		data.type === 'github'
			? { ...shared, repo: data.event.repoFullName, prNumber: data.event.workItemId }
			: data.type === 'merge-automation'
				? { ...shared, repo: data.repo, prNumber: data.prNumber }
				: { ...shared, workItemNodeId: data.event.itemNodeId, contentType: data.event.contentType },
	);
}

/**
 * Order to mirror dispatch intent: runnable (`waiting`/`prioritized`) first,
 * capacity-`blocked` next (eligible, waiting on a slot), `delayed` last;
 * priority ascending (0 highest); then FIFO within the same priority — enqueue
 * time for runnable jobs, scheduled run time for delayed ones.
 */
export function sortQueuedRuns(items: QueuedRun[]): QueuedRun[] {
	const stateRank = (state: PendingJobState): number =>
		state === 'delayed' ? 2 : state === 'blocked' ? 1 : 0;
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
 * The read model's entry point: map waiting dispatch rows to the API shape and
 * order them to mirror dispatch. Rows whose stored payload no longer parses are
 * skipped (they can't run either — the worker fails them at claim time).
 */
export function toQueuedRuns(dispatches: DispatchRow[]): QueuedRun[] {
	const mapped: QueuedRun[] = [];
	for (const dispatch of dispatches) {
		try {
			mapped.push(toQueuedRun(dispatch));
		} catch {
			// Malformed payload — the claim path surfaces it; don't break the list.
		}
	}
	return sortQueuedRuns(mapped);
}
