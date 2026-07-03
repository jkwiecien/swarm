import { describe, expect, it } from 'vitest';

import {
	PM_STATUS_KEYS,
	PM_STATUS_TO_PHASE,
	resolvePipelinePhaseForStatusKey,
} from '@/pm/pipeline.js';

describe('pipeline phase mapping', () => {
	it('maps the planning status to the planning phase', () => {
		expect(resolvePipelinePhaseForStatusKey('planning')).toBe('planning');
	});

	it('maps the inProgress status to the implementation phase', () => {
		expect(resolvePipelinePhaseForStatusKey('inProgress')).toBe('implementation');
	});

	it.each([
		'backlog',
		'todo',
		'inReview',
		'done',
	])('does not trigger a phase for the %s status (SCM-driven or terminal)', (statusKey) => {
		expect(resolvePipelinePhaseForStatusKey(statusKey)).toBeUndefined();
	});

	it('returns undefined for an unknown status key', () => {
		expect(resolvePipelinePhaseForStatusKey('nonsense')).toBeUndefined();
	});

	it('only the two PM-driven phases are in the map', () => {
		expect(Object.keys(PM_STATUS_TO_PHASE).sort()).toEqual(['inProgress', 'planning']);
	});

	it('keys the map only on canonical status keys (no drift from PM_STATUS_KEYS)', () => {
		for (const key of Object.keys(PM_STATUS_TO_PHASE)) {
			expect(PM_STATUS_KEYS).toContain(key);
		}
	});

	it('resolves every triggering canonical key (no silently-dead phase)', () => {
		// The Planning trigger is this issue's core deliverable: assert the canonical
		// `planning` key is present and resolves, so a rename can't silently kill it.
		expect(PM_STATUS_KEYS).toContain('planning');
		expect(resolvePipelinePhaseForStatusKey('planning')).toBe('planning');
	});
});
