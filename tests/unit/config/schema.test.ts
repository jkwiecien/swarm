import { describe, expect, it } from 'vitest';
import {
	PROJECT_DEFAULTS,
	ProjectConfigSchema,
	SwarmConfigSchema,
	validateConfig,
} from '@/config/schema.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

describe('ProjectConfigSchema', () => {
	it('accepts a fully-specified project', () => {
		const project = createMockProjectConfig();
		expect(project.repo).toBe('jkwiecien/swarm');
		expect(project.credentials.implementer).toBe('GITHUB_TOKEN_IMPLEMENTER');
		expect(project.githubProjects.statusFieldId).toBe('PVTSSF_lAHOAC3TF84BcNwDzhW4MKo');
	});

	it('applies worktree/branch/pm defaults when omitted', () => {
		const project = ProjectConfigSchema.parse({
			id: 'swarm',
			name: 'swarm',
			repo: 'jkwiecien/swarm',
			repoRoot: '/Users/dev/swarm/swarm',
			githubProjects: {
				projectId: 'PVT_x',
				statusFieldId: 'PVTSSF_y',
				statusOptions: { backlog: 'opt-1' },
			},
			credentials: {
				implementer: 'A',
				reviewer: 'B',
				webhookSecret: 'C',
			},
		});
		expect(project.worktreeRoot).toBe(PROJECT_DEFAULTS.worktreeRoot);
		expect(project.baseBranch).toBe(PROJECT_DEFAULTS.baseBranch);
		expect(project.branchPrefix).toBe(PROJECT_DEFAULTS.branchPrefix);
		expect(project.pm.type).toBe('github-projects');
	});

	it('rejects a repo that is not owner/repo', () => {
		expect(() => createMockProjectConfig({ repo: 'not-a-slug' })).toThrow(/owner\/repo/);
	});

	it('requires the githubProjects board mapping', () => {
		expect(() =>
			ProjectConfigSchema.parse({
				id: 'swarm',
				name: 'swarm',
				repo: 'jkwiecien/swarm',
				repoRoot: '/Users/dev/swarm/swarm',
				credentials: { implementer: 'A', reviewer: 'B', webhookSecret: 'C' },
			}),
		).toThrow();
	});

	it('requires every credential reference', () => {
		expect(() => createMockProjectConfig({ credentials: undefined as never })).toThrow();
		expect(() =>
			createMockProjectConfig({
				credentials: { implementer: 'A', reviewer: 'B', webhookSecret: '' },
			}),
		).toThrow();
	});
});

describe('validateConfig', () => {
	it('parses a config with at least one project', () => {
		const config = validateConfig({ projects: [createMockProjectConfig()] });
		expect(config.projects).toHaveLength(1);
	});

	it('rejects a config with no projects', () => {
		expect(() => validateConfig({ projects: [] })).toThrow();
	});

	it('rejects a non-object config', () => {
		expect(() => validateConfig(null)).toThrow();
	});

	it('is the SwarmConfigSchema parser', () => {
		expect(SwarmConfigSchema.safeParse({ projects: [createMockProjectConfig()] }).success).toBe(
			true,
		);
	});
});
