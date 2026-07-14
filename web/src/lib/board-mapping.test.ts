import { describe, expect, it } from 'vitest';
import type { GitHubProjectsIntegrationConfig } from '../../../src/integrations/pm/github-projects/config-schema.js';
import {
	buildGithubProjectsUpdate,
	cleanStatusOptions,
	isBoardMappingDirty,
	STATUS_KEYS,
	toBoardMappingForm,
} from './board-mapping.js';

const fullConfig: GitHubProjectsIntegrationConfig = {
	projectId: 'PVT_kwDODb1Ycc4Bcnwu',
	statusFieldId: 'PVTSSF_lADODb1Ycc4BcnwuzhXPKyM',
	statusOptions: {
		backlog: 'f75ad846',
		planning: '3fe662f4',
		todo: '61e4505c',
		inProgress: '47fc9ee4',
		inReview: 'df73e18b',
		done: '98236657',
	},
};

describe('toBoardMappingForm', () => {
	it('fills blanks for every canonical key when config is undefined', () => {
		const form = toBoardMappingForm(undefined);
		expect(form.projectId).toBe('');
		expect(form.statusFieldId).toBe('');
		for (const key of STATUS_KEYS) {
			expect(form.statusOptions[key]).toBe('');
		}
	});

	it('projects stored ids and only surfaces canonical keys', () => {
		const form = toBoardMappingForm({
			...fullConfig,
			// A board may carry a non-canonical key; it must not leak into the form.
			statusOptions: { ...fullConfig.statusOptions, custom: 'zzz' },
		});
		expect(form.projectId).toBe(fullConfig.projectId);
		expect(form.statusOptions.inReview).toBe('df73e18b');
		expect(Object.keys(form.statusOptions).sort()).toEqual([...STATUS_KEYS].sort());
	});

	it('leaves an unmapped canonical key blank', () => {
		const form = toBoardMappingForm({ ...fullConfig, statusOptions: { backlog: 'f75ad846' } });
		expect(form.statusOptions.backlog).toBe('f75ad846');
		expect(form.statusOptions.done).toBe('');
	});
});

describe('cleanStatusOptions', () => {
	it('drops blank and whitespace-only entries and trims the rest', () => {
		const cleaned = cleanStatusOptions({
			backlog: '  f75ad846  ',
			planning: '',
			todo: '   ',
			inProgress: '47fc9ee4',
			inReview: '',
			done: '',
		});
		expect(cleaned).toEqual({ backlog: 'f75ad846', inProgress: '47fc9ee4' });
	});
});

describe('buildGithubProjectsUpdate', () => {
	it('trims ids and cleans options', () => {
		const payload = buildGithubProjectsUpdate(
			{
				projectId: '  PVT_1  ',
				statusFieldId: 'PVTSSF_1',
				statusOptions: { ...toBoardMappingForm(undefined).statusOptions, planning: ' 3fe662f4 ' },
			},
			undefined,
		);
		expect(payload.projectId).toBe('PVT_1');
		expect(payload.statusOptions).toEqual({ planning: '3fe662f4' });
	});

	it('preserves phaseLabels from the existing config', () => {
		const existing: GitHubProjectsIntegrationConfig = {
			...fullConfig,
			phaseLabels: { 'phase-6': 'phase-6' },
		};
		const payload = buildGithubProjectsUpdate(toBoardMappingForm(existing), existing);
		expect(payload.phaseLabels).toEqual({ 'phase-6': 'phase-6' });
	});

	it('omits phaseLabels when the existing config has none', () => {
		const payload = buildGithubProjectsUpdate(toBoardMappingForm(fullConfig), fullConfig);
		expect(payload).not.toHaveProperty('phaseLabels');
	});
});

describe('isBoardMappingDirty', () => {
	it('is false when the form matches the stored config', () => {
		expect(isBoardMappingDirty(toBoardMappingForm(fullConfig), fullConfig)).toBe(false);
	});

	it('ignores surrounding whitespace when comparing', () => {
		const form = toBoardMappingForm(fullConfig);
		form.projectId = `  ${fullConfig.projectId}  `;
		expect(isBoardMappingDirty(form, fullConfig)).toBe(false);
	});

	it('is true when an option id changes', () => {
		const form = toBoardMappingForm(fullConfig);
		form.statusOptions.done = 'changed';
		expect(isBoardMappingDirty(form, fullConfig)).toBe(true);
	});

	it('is true when a field is filled against an empty config', () => {
		const form = toBoardMappingForm(undefined);
		form.statusFieldId = 'PVTSSF_1';
		expect(isBoardMappingDirty(form, undefined)).toBe(true);
	});
});
