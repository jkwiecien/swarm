import { describe, expect, it } from 'vitest';
import type { PipelineConfig } from '../../../src/config/schema.js';
import {
	autoAdvanceConfigPhase,
	autoAdvanceSummary,
	buildPipelineAutoAdvanceUpdate,
	buildPipelineEnabledUpdate,
	isAutoAdvancePhase,
	isPipelineAutoAdvanceDirty,
	isPipelineEnabledDirty,
	isRespondToReviewLocked,
	setAutoAdvanceEnabled,
	setPhaseEnabled,
	toPipelineAutoAdvanceForm,
	toPipelineEnabledForm,
} from './pipeline-enabled.js';

describe('auto-advance form mapping', () => {
	it('uses the coded Planning-off and Implementation-on defaults', () => {
		expect(toPipelineAutoAdvanceForm(undefined)).toEqual({ planning: false, implementation: true });
	});

	it('reads explicit values and reports only changed values as dirty', () => {
		const pipeline: PipelineConfig = {
			planning: { autoAdvance: true },
			implementation: { autoAdvance: false },
		};
		const form = toPipelineAutoAdvanceForm(pipeline);
		expect(form).toEqual({ planning: true, implementation: false });
		expect(isPipelineAutoAdvanceDirty(form, pipeline)).toBe(false);
		expect(isPipelineAutoAdvanceDirty({ ...form, planning: false }, pipeline)).toBe(true);
	});

	it('updates only auto-advance while preserving unrelated pipeline settings', () => {
		const existing: PipelineConfig = {
			planning: { autoAdvance: true, autoSplit: false },
			implementation: { autoAdvance: false },
			review: { enabled: false },
			respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
			respondToCi: { enabled: false },
		};
		expect(
			buildPipelineAutoAdvanceUpdate({ planning: false, implementation: true }, existing),
		).toEqual({
			...existing,
			planning: { autoAdvance: false, autoSplit: false },
			implementation: { autoAdvance: true },
		});
	});

	it('combines auto-advance and enabled edits without dropping other settings', () => {
		const existing: PipelineConfig = {
			planning: { autoSplit: false },
			implementation: {},
			review: {},
			respondToReview: { autoMerge: true, skipOnMinors: false },
			respondToCi: {},
		};
		const enabled = buildPipelineEnabledUpdate(
			{ review: false, respondToReview: true, respondToCi: false },
			existing,
		);

		expect(
			buildPipelineAutoAdvanceUpdate({ planning: true, implementation: false }, enabled),
		).toEqual({
			planning: { autoAdvance: true, autoSplit: false },
			implementation: { autoAdvance: false },
			review: { enabled: false },
			respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
			respondToCi: { enabled: false },
		});
	});
});

describe('toPipelineEnabledForm', () => {
	it('defaults every phase to enabled when config is undefined', () => {
		expect(toPipelineEnabledForm(undefined)).toEqual({
			review: true,
			respondToReview: true,
			respondToCi: true,
		});
	});

	it('treats an unset enabled flag as enabled', () => {
		const pipeline: PipelineConfig = { review: {}, respondToReview: { autoMerge: true } };
		expect(toPipelineEnabledForm(pipeline)).toEqual({
			review: true,
			respondToReview: true,
			respondToCi: true,
		});
	});

	it('reflects an explicit false as disabled', () => {
		const pipeline: PipelineConfig = {
			review: { enabled: false },
			respondToReview: { enabled: false },
			respondToCi: { enabled: false },
		};
		expect(toPipelineEnabledForm(pipeline)).toEqual({
			review: false,
			respondToReview: false,
			respondToCi: false,
		});
	});
});

describe('setPhaseEnabled', () => {
	const allOn = { review: true, respondToReview: true, respondToCi: true };

	it('toggles the named phase without touching the others', () => {
		expect(setPhaseEnabled(allOn, 'respondToCi', false)).toEqual({
			review: true,
			respondToReview: true,
			respondToCi: false,
		});
	});

	it('forces respond-to-review off when review is turned off', () => {
		expect(setPhaseEnabled(allOn, 'review', false)).toEqual({
			review: false,
			respondToReview: false,
			respondToCi: true,
		});
	});

	it('leaves respond-to-review untouched when review is turned on', () => {
		const reviewOff = { review: false, respondToReview: false, respondToCi: true };
		expect(setPhaseEnabled(reviewOff, 'review', true)).toEqual({
			review: true,
			respondToReview: false,
			respondToCi: true,
		});
	});

	it('does not mutate the input form', () => {
		const input = { ...allOn };
		setPhaseEnabled(input, 'review', false);
		expect(input).toEqual(allOn);
	});
});

describe('isRespondToReviewLocked', () => {
	it('locks respond-to-review when review is off', () => {
		expect(
			isRespondToReviewLocked({ review: false, respondToReview: false, respondToCi: true }),
		).toBe(true);
	});

	it('unlocks respond-to-review when review is on', () => {
		expect(
			isRespondToReviewLocked({ review: true, respondToReview: true, respondToCi: true }),
		).toBe(false);
	});
});

describe('buildPipelineEnabledUpdate', () => {
	it('writes explicit enabled flags for all three phases', () => {
		const result = buildPipelineEnabledUpdate(
			{ review: true, respondToReview: false, respondToCi: true },
			undefined,
		);
		expect(result.review?.enabled).toBe(true);
		expect(result.respondToReview?.enabled).toBe(false);
		expect(result.respondToCi?.enabled).toBe(true);
	});

	it('preserves existing pipeline fields the screen does not edit', () => {
		const existing: PipelineConfig = {
			planning: { autoAdvance: true, autoSplit: false },
			implementation: { autoAdvance: false },
			respondToReview: { autoMerge: true, skipOnMinors: false },
		};
		const result = buildPipelineEnabledUpdate(
			{ review: true, respondToReview: true, respondToCi: true },
			existing,
		);
		expect(result.planning).toEqual({ autoAdvance: true, autoSplit: false });
		expect(result.implementation).toEqual({ autoAdvance: false });
		expect(result.respondToReview?.autoMerge).toBe(true);
		expect(result.respondToReview?.skipOnMinors).toBe(false);
		expect(result.respondToReview?.enabled).toBe(true);
	});

	it('forces respond-to-review off when review is off (satisfies the server refinement)', () => {
		const result = buildPipelineEnabledUpdate(
			{ review: false, respondToReview: true, respondToCi: true },
			{ respondToReview: { autoMerge: true } },
		);
		expect(result.review?.enabled).toBe(false);
		expect(result.respondToReview?.enabled).toBe(false);
		// The unrelated field still survives.
		expect(result.respondToReview?.autoMerge).toBe(true);
	});
});

describe('isPipelineEnabledDirty', () => {
	it('is clean when the form matches the stored config', () => {
		const pipeline: PipelineConfig = {
			review: { enabled: false },
			respondToReview: { enabled: false },
		};
		expect(isPipelineEnabledDirty(toPipelineEnabledForm(pipeline), pipeline)).toBe(false);
	});

	it('is clean against undefined config when everything is on', () => {
		expect(
			isPipelineEnabledDirty({ review: true, respondToReview: true, respondToCi: true }, undefined),
		).toBe(false);
	});

	it('is dirty when a phase differs from the stored config', () => {
		expect(
			isPipelineEnabledDirty(
				{ review: true, respondToReview: true, respondToCi: false },
				undefined,
			),
		).toBe(true);
	});
});

describe('setAutoAdvanceEnabled', () => {
	it('sets the auto-advance value for a phase without mutating the input', () => {
		const form = { planning: false, implementation: true };
		const result = setAutoAdvanceEnabled(form, 'planning', true);
		expect(result).toEqual({ planning: true, implementation: true });
		expect(form).toEqual({ planning: false, implementation: true });
	});
});

describe('isAutoAdvancePhase', () => {
	it('correctly identifies planning and implementation as auto-advance phases', () => {
		expect(isAutoAdvancePhase('planning')).toBe(true);
		expect(isAutoAdvancePhase('implementation')).toBe(true);
	});

	it('rejects other phases', () => {
		expect(isAutoAdvancePhase('review')).toBe(false);
		expect(isAutoAdvancePhase('respondToReview')).toBe(false);
		expect(isAutoAdvancePhase('respondToCi')).toBe(false);
		expect(isAutoAdvancePhase('resolveConflicts')).toBe(false);
	});
});

describe('autoAdvanceConfigPhase', () => {
	it('maps Implementation (unplanned) to Implementation’s shared setting', () => {
		expect(autoAdvanceConfigPhase('implementationUnplanned')).toBe('implementation');
	});

	it('returns the stored phase for supported phases and nothing for others', () => {
		expect(autoAdvanceConfigPhase('planning')).toBe('planning');
		expect(autoAdvanceConfigPhase('implementation')).toBe('implementation');
		expect(autoAdvanceConfigPhase('review')).toBeUndefined();
	});
});

describe('autoAdvanceSummary', () => {
	it('returns N/A when enabled is undefined', () => {
		expect(autoAdvanceSummary('planning', undefined)).toBe('N/A');
		expect(autoAdvanceSummary('implementation', undefined)).toBe('N/A');
	});

	it('returns planning summary for true/false', () => {
		expect(autoAdvanceSummary('planning', true)).toBe('On — moves to ToDo after posting the plan');
		expect(autoAdvanceSummary('planning', false)).toBe('Off — stays in Planning');
	});

	it('returns implementation summary for true/false', () => {
		expect(autoAdvanceSummary('implementation', true)).toBe(
			'On — moves to In review after opening the PR',
		);
		expect(autoAdvanceSummary('implementation', false)).toBe('Off — stays in progress');
	});
});
