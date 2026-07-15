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
 * Whether any of the supplied raw prompt values is over the persisted bound.
 * Mirrors `customPromptError` across every phase so the Agent Configuration form
 * can block Save client-side instead of letting an over-limit prompt fail
 * server-side (issue #135). `undefined`/whitespace-only values are acceptable.
 */
export function anyCustomPromptError(values: Array<string | undefined>): boolean {
	return values.some((value) => customPromptError(value ?? '') !== undefined);
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
