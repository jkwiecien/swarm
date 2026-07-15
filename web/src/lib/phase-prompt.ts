/**
 * Pure helpers for the per-phase custom-prompt field (issue #135): validation,
 * dirty-checking, and the read-only summaries of each phase's fixed SWARM system
 * prompt shown alongside the editable Custom prompt input. Kept out of the route
 * component so they can be unit-tested (the owning route stays presentational,
 * mirroring `web/src/lib/pipeline-enabled.ts`).
 */

import {
	CUSTOM_PROMPT_MAX_LENGTH,
	normalizeCustomPrompt,
} from '../../../src/config/custom-prompt.js';

export { CUSTOM_PROMPT_MAX_LENGTH, normalizeCustomPrompt };

/** The six configurable phases, in display order — the keys of `agents.<phase>`. */
export type PhaseKey =
	| 'planning'
	| 'implementation'
	| 'review'
	| 'respondToReview'
	| 'respondToCi'
	| 'resolveConflicts';

/**
 * A validation message for a raw Custom-prompt textarea value, or `undefined`
 * when it's acceptable. Only the persisted (trimmed) length is bounded — trailing
 * whitespace a user is mid-typing never trips it, matching the schema, which
 * checks the normalized value (issue #135).
 */
export function customPromptError(value: string): string | undefined {
	const normalized = normalizeCustomPrompt(value);
	if (normalized && normalized.length > CUSTOM_PROMPT_MAX_LENGTH) {
		return `Custom prompt must be at most ${CUSTOM_PROMPT_MAX_LENGTH.toLocaleString()} characters (currently ${normalized.length.toLocaleString()}).`;
	}
	return undefined;
}

/**
 * Whether the locally-edited prompt differs from what's stored, comparing the
 * normalized forms so "  " vs unset (and "x " vs "x") don't read as dirty — the
 * same normalization the schema persists.
 */
export function isCustomPromptDirty(
	local: string | undefined,
	stored: string | undefined,
): boolean {
	return (normalizeCustomPrompt(local) ?? '') !== (normalizeCustomPrompt(stored) ?? '');
}

/**
 * A concise, read-only description of the fixed SWARM system prompt each phase
 * runs with — shown on the phase-detail screen so the user understands what
 * their custom prompt is appended to, without exposing the (non-editable) prompt
 * text itself. Not the prompt verbatim: a summary of what SWARM instructs the
 * agent to do in that phase.
 */
export const PHASE_SYSTEM_PROMPT_SUMMARY: Record<PhaseKey, string> = {
	planning:
		'SWARM instructs a read-only architect agent to explore the repository and write a step-by-step implementation plan (and, when task-splitting is on, to split an over-large item), without editing any source.',
	implementation:
		'SWARM instructs an engineer agent to implement the work item against its plan, verify with lint/type-check/tests, and hand the prepared change back for SWARM to deliver — it does not push or open the PR itself.',
	review:
		'SWARM instructs a review-only agent to read the PR, linked issue, and full diff, verify each finding against the checkout, and record a verdict — never editing code or submitting the review itself.',
	respondToReview:
		'SWARM instructs the PR author agent to sync the branch, address every review point as a fix or a reasoned push-back, verify any fix, and always reply on the PR — SWARM delivers the response.',
	respondToCi:
		'SWARM instructs the PR author agent to sync the branch, inspect the failing checks, fix the build surgically (or report that no code change is warranted), and verify locally — SWARM delivers the outcome.',
	resolveConflicts:
		'SWARM instructs an implementer agent to merge the base branch into the conflicted PR branch, resolve every conflict preserving both sides, and verify — leaving the resolved merge for SWARM to deliver.',
};
