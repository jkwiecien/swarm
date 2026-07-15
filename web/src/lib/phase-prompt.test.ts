import { describe, expect, it } from 'vitest';
import {
	CUSTOM_PROMPT_MAX_LENGTH,
	customPromptError,
	isCustomPromptDirty,
	normalizeCustomPrompt,
	PHASE_SYSTEM_PROMPT_SUMMARY,
	type PhaseKey,
} from './phase-prompt.js';

const ALL_PHASES: PhaseKey[] = [
	'planning',
	'implementation',
	'review',
	'respondToReview',
	'respondToCi',
	'resolveConflicts',
];

describe('normalizeCustomPrompt', () => {
	it('trims and treats blank/whitespace-only as unset', () => {
		expect(normalizeCustomPrompt('  hi  ')).toBe('hi');
		expect(normalizeCustomPrompt('   ')).toBeUndefined();
		expect(normalizeCustomPrompt('')).toBeUndefined();
		expect(normalizeCustomPrompt(undefined)).toBeUndefined();
	});
});

describe('customPromptError', () => {
	it('accepts empty and within-bound values', () => {
		expect(customPromptError('')).toBeUndefined();
		expect(customPromptError('a'.repeat(CUSTOM_PROMPT_MAX_LENGTH))).toBeUndefined();
	});

	it('rejects a value over the bound', () => {
		expect(customPromptError('a'.repeat(CUSTOM_PROMPT_MAX_LENGTH + 1))).toMatch(/at most/);
	});

	it('measures the trimmed length, so trailing whitespace does not trip it', () => {
		expect(customPromptError(`${'a'.repeat(CUSTOM_PROMPT_MAX_LENGTH)}     `)).toBeUndefined();
	});
});

describe('isCustomPromptDirty', () => {
	it('compares normalized forms', () => {
		expect(isCustomPromptDirty('  x  ', 'x')).toBe(false);
		expect(isCustomPromptDirty('   ', undefined)).toBe(false);
		expect(isCustomPromptDirty('', undefined)).toBe(false);
		expect(isCustomPromptDirty('x', undefined)).toBe(true);
		expect(isCustomPromptDirty('x', 'y')).toBe(true);
	});
});

describe('PHASE_SYSTEM_PROMPT_SUMMARY', () => {
	it('has a non-empty read-only summary for every phase', () => {
		for (const phase of ALL_PHASES) {
			expect(PHASE_SYSTEM_PROMPT_SUMMARY[phase]?.length ?? 0).toBeGreaterThan(0);
		}
	});
});
