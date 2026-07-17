/**
 * Pure display helpers for the Queued section (issue #238). They only derive
 * label text and a stable key from an already-fetched {@link QueuedRun}; the
 * server owns the ordering (dispatch priority + FIFO), so nothing here re-sorts.
 * Kept side-effect-free so they can be unit-tested in the node environment,
 * matching the other `web/src/lib/*.test.ts` helpers.
 */

import type { QueuedPhaseHint, QueuedRun } from '@/types/runs.js';
import { formatPhase } from './format.js';

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
 * Shorten an opaque GitHub Projects item node id to a stable, readable tail so a
 * board item is identifiable without dumping the full ~30-char id. Short ids are
 * returned unchanged.
 */
export function shortNodeId(nodeId: string): string {
	return nodeId.length <= 8 ? nodeId : `…${nodeId.slice(-6)}`;
}

/**
 * A work-item reference for one queued job:
 * - `github` jobs → `owner/repo #<n>` (or `#<n>` if the repo is somehow absent);
 * - `github-projects` jobs → `<contentType> · <shortNodeId>` (either part may be
 *   missing, so it degrades gracefully to a generic "Board item").
 */
export function queuedWorkItemLabel(item: QueuedRun): string {
	if (item.type === 'github') {
		const ref = `#${item.prNumber ?? '?'}`;
		return item.repo ? `${item.repo} ${ref}` : ref;
	}
	const parts = [
		item.contentType,
		item.workItemNodeId ? shortNodeId(item.workItemNodeId) : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(' · ') : 'Board item';
}

/** Stable React key for a queued row — the BullMQ job id is unique per pending job. */
export function queuedRunKey(item: QueuedRun): string {
	return item.jobId;
}
