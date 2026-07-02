/**
 * Test data factories — sensible defaults + `Partial<T>` overrides, mirroring
 * Cascade's `tests/helpers/factories.ts` (ai/TESTING.md "Test data"). Prefer
 * these over hand-constructing the same fixture object inline in every test.
 *
 * Each factory returns a *validated* object (run through its Zod schema, so
 * defaults are applied) — tests exercising invalid input build raw objects
 * directly instead.
 */

import { type ProjectConfig, ProjectConfigSchema } from '@/config/schema.js';
import {
	type GitHubProjectsIntegrationConfig,
	githubProjectsConfigSchema,
} from '@/integrations/pm/github-projects/config-schema.js';
import type { WorkItem } from '@/pm/types.js';

export function createMockGitHubProjectsConfig(
	overrides: Partial<GitHubProjectsIntegrationConfig> = {},
): GitHubProjectsIntegrationConfig {
	return githubProjectsConfigSchema.parse({
		projectId: 'PVT_kwHOAC3TF84BcNwD',
		statusFieldId: 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo',
		statusOptions: {
			backlog: 'f75ad846',
			ready: '61e4505c',
			inProgress: '47fc9ee4',
			inReview: 'df73e18b',
			done: '98236657',
		},
		...overrides,
	});
}

/**
 * A `WorkItem` fixture. Unlike the config factories above there's no Zod schema
 * to parse through — `WorkItem` is a provider-agnostic interface (`src/pm/types.ts`),
 * not a boundary-crossing config shape — so this returns a plain object.
 */
export function createMockWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
		title: 'Example work item',
		description: 'An example work item body.',
		url: 'https://github.com/jkwiecien/swarm/issues/10',
		status: 'In progress',
		statusId: '47fc9ee4',
		labels: [],
		...overrides,
	};
}

export function createMockProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return ProjectConfigSchema.parse({
		id: 'swarm',
		name: 'swarm',
		repo: 'jkwiecien/swarm',
		repoRoot: '/Users/dev/swarm/swarm',
		githubProjects: createMockGitHubProjectsConfig(),
		credentials: {
			implementer: 'GITHUB_TOKEN_IMPLEMENTER',
			reviewer: 'GITHUB_TOKEN_REVIEWER',
			webhookSecret: 'GITHUB_WEBHOOK_SECRET',
		},
		...overrides,
	});
}
