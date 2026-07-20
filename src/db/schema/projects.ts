import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type {
	AgentsConfig,
	Credentials,
	PipelineConfig,
	WorktreeRetentionConfig,
} from '../../config/schema.js';
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
	maxConcurrentJobs: integer('max_concurrent_jobs')
		.notNull()
		.default(PROJECT_DEFAULTS.maxConcurrentJobs),
	/**
	 * Discovery / open-join policy — one of `ProjectVisibilitySchema`
	 * (`src/config/schema.ts`, the source of truth for the values), stored as
	 * free `text` like `pm_type`. `private` (members only) by default;
	 * `discoverable` opts the project into the limited public-discovery read and
	 * join-request flow (#281 task 5). Never wired to execution or routing.
	 */
	visibility: text('visibility').notNull().default('private'),
	pmType: text('pm_type').notNull().default('github-projects'),
	githubProjects: jsonb('github_projects').$type<GitHubProjectsIntegrationConfig>().notNull(),
	credentials: jsonb('credentials').$type<Credentials>().notNull(),
	/** Per-phase agent CLI/model overrides (`AgentsConfig`) — nullable: most projects omit it entirely. */
	agents: jsonb('agents').$type<AgentsConfig>(),
	/** Per-phase autonomous board-move control (`PipelineConfig`) — nullable: most projects omit it entirely. */
	pipeline: jsonb('pipeline').$type<PipelineConfig>(),
	/** Per-project worktree retention policy (`WorktreeRetentionConfig`) — nullable: most projects omit it and use the coded default. */
	worktreeRetention: jsonb('worktree_retention').$type<WorktreeRetentionConfig>(),

	createdAt: timestamp('created_at').defaultNow(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date()),
});
