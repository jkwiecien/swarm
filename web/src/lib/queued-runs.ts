/**
 * Pure display helpers for the Queued section (issue #238). They only derive
 * label text and a stable key from an already-fetched {@link QueuedRun}; the
 * server owns the ordering (dispatch priority + FIFO), so nothing here re-sorts.
 * Kept side-effect-free so they can be unit-tested in the node environment,
 * matching the other `web/src/lib/*.test.ts` helpers.
 */

import type { QueuedPhaseHint, QueuedReviewGateSourceEvent, QueuedRun } from '@/types/runs.js';
import { formatPhase } from './format.js';
import { parseWorkItemRef, workItemLabel } from './work-item.js';

const PR_DRIVEN_PHASES = new Set([
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);

/**
 * Human-readable label for a job's best-effort phase hint. `board` covers both
 * Planning and Implementation (only distinguished at authoritative dispatch), so
 * it reads as such rather than pretending to know which one. Any hint not listed
 * falls back to {@link formatPhase} so a newly-added server hint still renders.
 */
const QUEUED_PHASE_LABELS: Record<QueuedPhaseHint, string> = {
	board: 'Board (Planning/Impl)',
	review: 'Review',
	'respond-to-review': 'Respond to review',
	'respond-to-ci': 'Respond to CI',
	'resolve-conflicts': 'Resolve conflicts',
	unknown: 'Unknown',
};

export function queuedPhaseLabel(hint: QueuedPhaseHint): string {
	return QUEUED_PHASE_LABELS[hint] ?? formatPhase(hint);
}

/**
 * A work-item reference for one queued job:
 * - resolved board jobs use the same Issue/PR label as the persisted Runs list;
 * - PR-driven GitHub jobs use the same `PR #<n>` label as that list;
 * - unresolved jobs show an honest em dash instead of an opaque node id.
 */
export function queuedWorkItemLabel(item: QueuedRun): string {
	const workItemRef = parseWorkItemRef(item.workItemUrl);
	if (workItemRef) return workItemLabel(workItemRef);
	if (item.type === 'github' && item.prNumber) return `PR #${item.prNumber}`;
	return '—';
}

export function queuedWorkItemTitle(item: QueuedRun): string | undefined {
	return item.workItemTitle || undefined;
}

export function queuedWorkItemUrl(item: QueuedRun): string | undefined {
	if (item.workItemUrl) return item.workItemUrl;
	if (
		item.type === 'github' &&
		item.repo &&
		item.prNumber &&
		PR_DRIVEN_PHASES.has(item.phaseHint)
	) {
		return `https://github.com/${item.repo}/pull/${item.prNumber}`;
	}
	return undefined;
}

/** Stable React key for a queued row — the BullMQ job id is unique per pending job. */
export function queuedRunKey(item: QueuedRun): string {
	return item.jobId;
}

/** One source event folded into a grouped review-gate row, for diagnostics display. */
export interface QueuedReviewGateSourceEventDisplay {
	jobId: string;
	sourceEvent: QueuedReviewGateSourceEvent;
	sourceAction?: string;
	recheckAttempt?: number;
}

/**
 * One row for the Queued table (issue #275): a plain queued job rendered
 * one-to-one, or several pending review-gate jobs for the same PR + head SHA
 * folded into one logical row. `representative` is always the *first* source
 * job in the supplied order — the same job {@link queuedRunKey} and the Put
 * back action key off, so grouping never changes which underlying job an
 * action targets.
 */
export interface QueuedDisplayRow {
	representative: QueuedRun;
	/** True once a second (or later) source event has joined this row's group. */
	isReviewGateGroup: boolean;
	/** One entry per source event folded into this row; empty when the job carries no review-gate metadata. */
	sourceEvents: QueuedReviewGateSourceEventDisplay[];
}

/** Grouping identity for a review-gate job: same project, repo, PR, and head SHA never split across rows. */
function reviewGateGroupKey(item: QueuedRun): string | null {
	if (!item.reviewGate || !item.repo || !item.prNumber) return null;
	return [item.projectId, item.repo, item.prNumber, item.reviewGate.headSha].join(':');
}

function toSourceEventDisplay(item: QueuedRun): QueuedReviewGateSourceEventDisplay {
	// Only called once `item.reviewGate` has already been checked truthy.
	const gate = item.reviewGate as NonNullable<QueuedRun['reviewGate']>;
	return {
		jobId: item.jobId,
		sourceEvent: gate.sourceEvent,
		sourceAction: gate.sourceAction,
		recheckAttempt: gate.recheckAttempt,
	};
}

/**
 * Turn the server's already-ordered `runs.queued` rows into display rows,
 * grouping pending review-gate jobs — raw `pull_request`/`check_suite`
 * lifecycle events hinting `review` (see {@link QueuedRun.reviewGate}) — that
 * share the same project, repo, PR number, and head SHA into one row. Every
 * other job renders one row per job, exactly as before. A row's position is
 * the position of the first job that started its group, so this never
 * reorders the server's dispatch order; it only folds later duplicates into
 * an earlier row. Never groups across a different project, repo, PR, or SHA
 * (or a job missing the identity a safe group needs).
 */
export function groupQueuedRuns(items: QueuedRun[]): QueuedDisplayRow[] {
	const rowByGroupKey = new Map<string, QueuedDisplayRow>();
	const rows: QueuedDisplayRow[] = [];

	for (const item of items) {
		const key = reviewGateGroupKey(item);
		const existingRow = key ? rowByGroupKey.get(key) : undefined;
		if (existingRow) {
			existingRow.isReviewGateGroup = true;
			existingRow.sourceEvents.push(toSourceEventDisplay(item));
			continue;
		}

		const row: QueuedDisplayRow = {
			representative: item,
			isReviewGateGroup: false,
			sourceEvents: item.reviewGate ? [toSourceEventDisplay(item)] : [],
		};
		rows.push(row);
		if (key) rowByGroupKey.set(key, row);
	}

	return rows;
}

const REVIEW_GATE_SOURCE_LABELS: Record<QueuedReviewGateSourceEvent, string> = {
	pull_request: 'Pull request',
	check_suite: 'Check suite',
};

/** Compact diagnostic label for one source event folded into a review-gate group. */
export function reviewGateSourceEventLabel(event: QueuedReviewGateSourceEventDisplay): string {
	const base = REVIEW_GATE_SOURCE_LABELS[event.sourceEvent];
	const action = event.sourceAction ? ` · ${event.sourceAction}` : '';
	const recheck = event.recheckAttempt !== undefined ? ` · recheck #${event.recheckAttempt}` : '';
	return `${base}${action}${recheck}`;
}

/** The wording a grouped review-gate row uses instead of claiming a Review agent is queued. */
export const REVIEW_GATE_GROUP_LABEL = 'Awaiting review decision/checks';
