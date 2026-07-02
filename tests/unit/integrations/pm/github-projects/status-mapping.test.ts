import { describe, expect, it } from 'vitest';

import {
	resolvePipelinePhaseForOptionId,
	resolveStatusKeyByOptionId,
} from '@/integrations/pm/github-projects/status-mapping.js';
import { createMockGitHubProjectsConfig } from '../../../../helpers/factories.js';

// The real board's Status option IDs (ai/RULES.md §5), mapped to the canonical
// pipeline status keys the config uses.
const config = createMockGitHubProjectsConfig({
	statusOptions: {
		backlog: 'f75ad846',
		planning: '61e4505c',
		todo: '3121a97d',
		inProgress: '47fc9ee4',
		inReview: 'df73e18b',
		done: '98236657',
	},
});

describe('resolveStatusKeyByOptionId', () => {
	it('inverts the statusOptions map (option ID → status key)', () => {
		expect(resolveStatusKeyByOptionId(config, '47fc9ee4')).toBe('inProgress');
		expect(resolveStatusKeyByOptionId(config, '61e4505c')).toBe('planning');
	});

	it('returns undefined for an option ID not on the board', () => {
		expect(resolveStatusKeyByOptionId(config, 'deadbeef')).toBeUndefined();
	});
});

describe('resolvePipelinePhaseForOptionId', () => {
	it('resolves the Planning option to the planning phase', () => {
		expect(resolvePipelinePhaseForOptionId(config, '61e4505c')).toBe('planning');
	});

	it('resolves the In-progress option to the implementation phase', () => {
		expect(resolvePipelinePhaseForOptionId(config, '47fc9ee4')).toBe('implementation');
	});

	it.each([
		['Backlog', 'f75ad846'],
		['ToDo', '3121a97d'],
		['In review', 'df73e18b'],
		['Done', '98236657'],
	])('does not trigger a phase for the %s option', (_name, optionId) => {
		expect(resolvePipelinePhaseForOptionId(config, optionId)).toBeUndefined();
	});

	it('returns undefined for an unmapped option ID', () => {
		expect(resolvePipelinePhaseForOptionId(config, 'deadbeef')).toBeUndefined();
	});
});
