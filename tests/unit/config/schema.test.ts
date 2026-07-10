import { describe, expect, it } from 'vitest';
import {
	AgentsConfigSchema,
	PipelineConfigSchema,
	PROJECT_DEFAULTS,
	ProjectConfigSchema,
	SwarmConfigSchema,
	validateConfig,
	type WorktreeRetentionConfig,
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

	it('omits agents entirely by default (every phase keeps its coded default)', () => {
		const project = createMockProjectConfig();
		expect(project.agents).toBeUndefined();
	});

	it('accepts a per-phase agent CLI/model override', () => {
		const project = createMockProjectConfig({
			agents: {
				planning: { cli: 'claude', model: 'sonnet' },
				implementation: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' },
				review: { cli: 'codex', model: 'gpt-5.6-sol' },
			},
		});
		expect(project.agents).toEqual({
			planning: { cli: 'claude', model: 'sonnet' },
			implementation: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' },
			review: { cli: 'codex', model: 'gpt-5.6-sol' },
		});
	});

	it('rejects an unknown cli value in an agent override', () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'gpt' as never } } }),
		).toThrow();
	});

	it('rejects a model not in the known list for its cli', () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'claude', model: 'nonsense' } } }),
		).toThrow(/known models/);
	});

	it("rejects a claude alias passed under cli: 'antigravity' (and vice versa)", () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'antigravity', model: 'sonnet' } } }),
		).toThrow();
		expect(() =>
			createMockProjectConfig({
				agents: { review: { cli: 'claude', model: 'Gemini 3.5 Flash (High)' } },
			}),
		).toThrow();
	});

	it("rejects a codex model under cli: 'claude' and a claude alias under cli: 'codex'", () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'claude', model: 'gpt-5.6-sol' } } }),
		).toThrow();
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'codex', model: 'sonnet' } } }),
		).toThrow();
	});

	it('checks a model against the combined list when cli is omitted', () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { model: 'sonnet' } } }),
		).not.toThrow();
		expect(() =>
			createMockProjectConfig({
				agents: { planning: { model: 'Gemini 3.5 Flash (High)' } },
			}),
		).not.toThrow();
		expect(() =>
			createMockProjectConfig({ agents: { planning: { model: 'gpt-5.6-sol' } } }),
		).not.toThrow();
		expect(() =>
			createMockProjectConfig({ agents: { planning: { model: 'nonsense' } } }),
		).toThrow();
	});

	it('omits pipeline entirely by default (planning/implementation keep their coded defaults)', () => {
		const project = createMockProjectConfig();
		expect(project.pipeline).toBeUndefined();
	});

	it('accepts a per-phase autoAdvance override', () => {
		const project = createMockProjectConfig({
			pipeline: { planning: { autoAdvance: true }, implementation: { autoAdvance: false } },
		});
		expect(project.pipeline).toEqual({
			planning: { autoAdvance: true },
			implementation: { autoAdvance: false },
		});
	});

	it('omits worktreeRetention entirely by default', () => {
		const project = createMockProjectConfig();
		expect(project.worktreeRetention).toBeUndefined();
	});

	it('applies defaults to worktreeRetention.maxWorktrees when the block is present but field is omitted', () => {
		const project = createMockProjectConfig({
			worktreeRetention: {} as unknown as WorktreeRetentionConfig,
		});
		expect(project.worktreeRetention).toEqual({
			maxWorktrees: PROJECT_DEFAULTS.maxWorktrees,
		});
	});

	it('accepts a valid worktreeRetention config', () => {
		const project = createMockProjectConfig({
			worktreeRetention: { maxWorktrees: 5 },
		});
		expect(project.worktreeRetention?.maxWorktrees).toBe(5);
	});

	it('rejects a non-positive or non-integer maxWorktrees', () => {
		expect(() =>
			createMockProjectConfig({
				worktreeRetention: { maxWorktrees: 0 },
			}),
		).toThrow();

		expect(() =>
			createMockProjectConfig({
				worktreeRetention: { maxWorktrees: -3 },
			}),
		).toThrow();

		expect(() =>
			createMockProjectConfig({
				worktreeRetention: { maxWorktrees: 5.5 },
			}),
		).toThrow();
	});
});

describe('AgentsConfigSchema', () => {
	it('allows every phase to be omitted', () => {
		expect(AgentsConfigSchema.safeParse({}).success).toBe(true);
	});

	it('allows cli and model to each be specified independently', () => {
		expect(AgentsConfigSchema.safeParse({ review: { cli: 'claude' } }).success).toBe(true);
		expect(AgentsConfigSchema.safeParse({ review: { model: 'opus' } }).success).toBe(true);
	});
});

describe('PipelineConfigSchema', () => {
	it('allows both phases to be omitted', () => {
		expect(PipelineConfigSchema.safeParse({}).success).toBe(true);
	});

	it('allows planning and implementation to be set independently', () => {
		expect(PipelineConfigSchema.safeParse({ planning: { autoAdvance: true } }).success).toBe(true);
		expect(PipelineConfigSchema.safeParse({ implementation: { autoAdvance: false } }).success).toBe(
			true,
		);
	});

	it('rejects a non-boolean autoAdvance', () => {
		expect(PipelineConfigSchema.safeParse({ planning: { autoAdvance: 'yes' } }).success).toBe(
			false,
		);
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
