import { describe, expect, it } from 'vitest';

import { PM_STATUS_TO_PHASE, resolvePipelinePhaseForStatusKey } from '@/pm/pipeline.js';

describe('pipeline phase mapping', () => {
	it('maps the planning status to the planning phase', () => {
		expect(resolvePipelinePhaseForStatusKey('planning')).toBe('planning');
	});

	it('maps the inProgress status to the implementation phase', () => {
		expect(resolvePipelinePhaseForStatusKey('inProgress')).toBe('implementation');
	});

	it.each([
		'backlog',
		'ready',
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
});
