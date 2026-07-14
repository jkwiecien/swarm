import { describe, expect, it } from 'vitest';
import type { PipelineConfig } from '../../../src/config/schema.js';
import {
	buildPipelineEnabledUpdate,
	isPipelineEnabledDirty,
	isRespondToReviewLocked,
	setPhaseEnabled,
	toPipelineEnabledForm,
} from './pipeline-enabled.js';

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
