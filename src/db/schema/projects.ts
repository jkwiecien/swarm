import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { Credentials } from '../../config/schema.js';
import { PROJECT_DEFAULTS } from '../../config/schema.js';
import type { GitHubProjectsIntegrationConfig } from '../../integrations/pm/github-projects/config-schema.js';

/**
 * One row per SWARM project — the persisted form of `ProjectConfig`
 * (`src/config/schema.ts`), which stays the source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). The jsonb columns are
 * typed with the config's own inferred types via `$type<>()` so the table and
 * the Zod schema can't drift.
 *
 * Single-user scope (ai/ARCHITECTURE.md "Single-user scope"): there is no
 * `organizations` table and no `org_id` FK — a deliberate simplification of
 * Cascade's org→project hierarchy. One row per project, one credential set per
 * persona per project.
 *
 * The `credentials` column holds only *references* (env-var keys into the
 * secret store), never the secrets themselves — those live encrypted at rest in
 * `project_credentials` (ai/CODING_STANDARDS.md "Scope credentials"; PROJECT.md
 * §6.1).
 */
export const projects = pgTable('projects', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	repo: text('repo').notNull().unique(),
	repoRoot: text('repo_root').notNull(),
	worktreeRoot: text('worktree_root').notNull().default(PROJECT_DEFAULTS.worktreeRoot),
	baseBranch: text('base_branch').notNull().default(PROJECT_DEFAULTS.baseBranch),
	branchPrefix: text('branch_prefix').notNull().default(PROJECT_DEFAULTS.branchPrefix),
	pmType: text('pm_type').notNull().default('github-projects'),
	githubProjects: jsonb('github_projects').$type<GitHubProjectsIntegrationConfig>().notNull(),
	credentials: jsonb('credentials').$type<Credentials>().notNull(),

	createdAt: timestamp('created_at').defaultNow(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date()),
});
