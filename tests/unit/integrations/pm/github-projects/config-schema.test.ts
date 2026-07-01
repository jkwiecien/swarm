import { describe, expect, it } from 'vitest';
import { githubProjectsConfigSchema } from '@/integrations/pm/github-projects/config-schema.js';
import { createMockGitHubProjectsConfig } from '../../../../helpers/factories.js';

describe('githubProjectsConfigSchema', () => {
	it('accepts a valid board mapping', () => {
		const config = createMockGitHubProjectsConfig();
		expect(config.projectId).toBe('PVT_kwHOAC3TF84BcNwD');
		expect(config.statusOptions.inProgress).toBe('47fc9ee4');
	});

	it('round-trips a parsed config unchanged (no drift, no stripped fields)', () => {
		const input = {
			projectId: 'PVT_x',
			statusFieldId: 'PVTSSF_y',
			statusOptions: { backlog: 'opt-1', done: 'opt-2' },
			phaseLabels: { 'phase-0': 'phase-0' },
		};
		expect(githubProjectsConfigSchema.parse(input)).toEqual(input);
	});

	it('treats phaseLabels as optional', () => {
		const config = createMockGitHubProjectsConfig();
		expect(config.phaseLabels).toBeUndefined();
	});

	it('rejects an empty projectId', () => {
		expect(() =>
			githubProjectsConfigSchema.parse({
				projectId: '',
				statusFieldId: 'PVTSSF_y',
				statusOptions: { backlog: 'opt-1' },
			}),
		).toThrow();
	});

	it('rejects an empty status-option value', () => {
		expect(() =>
			githubProjectsConfigSchema.parse({
				projectId: 'PVT_x',
				statusFieldId: 'PVTSSF_y',
				statusOptions: { backlog: '' },
			}),
		).toThrow();
	});

	it('rejects a missing statusFieldId', () => {
		expect(() =>
			githubProjectsConfigSchema.parse({
				projectId: 'PVT_x',
				statusOptions: { backlog: 'opt-1' },
			}),
		).toThrow();
	});
});
