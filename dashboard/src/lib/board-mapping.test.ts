import { describe, expect, it } from 'vitest';
import type { GitHubProjectsIntegrationConfig } from '../../../src/integrations/pm/github-projects/config-schema.js';
import {
	buildGithubProjectsUpdate,
	canSaveBoardMapping,
	cleanStatusOptions,
	getPmMappingProvider,
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
	it('fills blanks and defaults the provider when config is undefined', () => {
		const form = toBoardMappingForm(undefined);
		expect(form.providerId).toBe('github-projects');
		expect(form.containerId).toBe('');
		expect(form.providerContext).toEqual({});
		for (const key of STATUS_KEYS) {
			expect(form.statusOptions[key]).toBe('');
		}
	});

	it('projects the stored board, field context, and only canonical status keys', () => {
		const form = toBoardMappingForm({
			...fullConfig,
			// A board may carry a non-canonical key; it must not leak into the form.
			statusOptions: { ...fullConfig.statusOptions, custom: 'zzz' },
		});
		expect(form.containerId).toBe(fullConfig.projectId);
		expect(form.providerContext).toEqual({ statusFieldId: fullConfig.statusFieldId });
		expect(form.statusOptions.inReview).toBe('df73e18b');
		expect(Object.keys(form.statusOptions).sort()).toEqual([...STATUS_KEYS].sort());
	});

	it('carries the provided provider id through', () => {
		expect(toBoardMappingForm(fullConfig, 'github-projects').providerId).toBe('github-projects');
	});

	it('leaves an unmapped canonical key blank and omits absent field context', () => {
		const form = toBoardMappingForm({
			projectId: 'PVT_1',
			statusFieldId: '',
			statusOptions: { backlog: 'f75ad846' },
		} as GitHubProjectsIntegrationConfig);
		expect(form.statusOptions.backlog).toBe('f75ad846');
		expect(form.statusOptions.done).toBe('');
		expect(form.providerContext).toEqual({});
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
	it('serializes the container to projectId and the discovered field context to statusFieldId', () => {
		const payload = buildGithubProjectsUpdate(
			{
				providerId: 'github-projects',
				containerId: '  PVT_1  ',
				statusOptions: { ...toBoardMappingForm(undefined).statusOptions, planning: ' 3fe662f4 ' },
				providerContext: { statusFieldId: '  PVTSSF_1  ' },
			},
			undefined,
		);
		expect(payload.projectId).toBe('PVT_1');
		expect(payload.statusFieldId).toBe('PVTSSF_1');
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
		form.containerId = `  ${fullConfig.projectId}  `;
		expect(isBoardMappingDirty(form, fullConfig)).toBe(false);
	});

	it('is true when an option id changes', () => {
		const form = toBoardMappingForm(fullConfig);
		form.statusOptions.done = 'changed';
		expect(isBoardMappingDirty(form, fullConfig)).toBe(true);
	});

	it('is true when the discovered Status field context changes', () => {
		const form = toBoardMappingForm(fullConfig);
		form.providerContext = { statusFieldId: 'PVTSSF_other' };
		expect(isBoardMappingDirty(form, fullConfig)).toBe(true);
	});

	it('is true when a board is selected against an empty config', () => {
		const form = toBoardMappingForm(undefined);
		form.containerId = 'PVT_1';
		expect(isBoardMappingDirty(form, undefined)).toBe(true);
	});
});

describe('canSaveBoardMapping', () => {
	it('requires a board, a Status field context, and at least one mapped status', () => {
		expect(canSaveBoardMapping(toBoardMappingForm(fullConfig))).toBe(true);
	});

	it('is false without a selected board', () => {
		const form = toBoardMappingForm(fullConfig);
		form.containerId = '';
		expect(canSaveBoardMapping(form)).toBe(false);
	});

	it('is false without a Status field context', () => {
		const form = toBoardMappingForm(fullConfig);
		form.providerContext = {};
		expect(canSaveBoardMapping(form)).toBe(false);
	});

	it('is false when no status is mapped', () => {
		const form = toBoardMappingForm(undefined);
		form.containerId = 'PVT_1';
		form.providerContext = { statusFieldId: 'PVTSSF_1' };
		expect(canSaveBoardMapping(form)).toBe(false);
	});
});

describe('getPmMappingProvider', () => {
	it('returns the matching provider and falls back to the default for an unknown id', () => {
		expect(getPmMappingProvider('github-projects').label).toBe('GitHub Projects');
		expect(getPmMappingProvider('nope').id).toBe('github-projects');
	});
});
