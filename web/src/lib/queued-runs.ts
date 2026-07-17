/**
 * Pure display helpers for the Queued section (issue #238). They only derive
 * label text and a stable key from an already-fetched {@link QueuedRun}; the
 * server owns the ordering (dispatch priority + FIFO), so nothing here re-sorts.
 * Kept side-effect-free so they can be unit-tested in the node environment,
 * matching the other `web/src/lib/*.test.ts` helpers.
 */

import type { QueuedPhaseHint, QueuedRun } from '@/types/runs.js';
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
