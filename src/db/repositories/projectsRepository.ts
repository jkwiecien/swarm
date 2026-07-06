/**
 * Project lookups from Postgres — mirrors the read side of Cascade's
 * `src/db/repositories/projectsRepository.ts`, trimmed to SWARM's single-user
 * scope (one row per project, no org hierarchy — ai/ARCHITECTURE.md
 * "Single-user scope").
 *
 * A `projects` row is the persisted form of `ProjectConfig`; the jsonb columns
 * are already typed with the config's inferred types (`src/db/schema/projects.ts`),
 * so mapping a row back to `ProjectConfig` is a re-assembly, not a re-validation.
 * The Zod schema stays the source of truth for the shape (ai/CODING_STANDARDS.md
 * "Zod is the source of truth").
 */

import { eq, sql } from 'drizzle-orm';

import type { ProjectConfig } from '../../config/schema.js';
import { getDb } from '../client.js';
import { projects } from '../schema/projects.js';

type ProjectRow = typeof projects.$inferSelect;

/** Re-assemble a `ProjectConfig` from a persisted `projects` row. */
function rowToProjectConfig(row: ProjectRow): ProjectConfig {
	return {
		id: row.id,
		name: row.name,
		repo: row.repo,
		repoRoot: row.repoRoot,
		worktreeRoot: row.worktreeRoot,
		baseBranch: row.baseBranch,
		branchPrefix: row.branchPrefix,
		pm: { type: row.pmType as 'github-projects' },
		githubProjects: row.githubProjects,
		credentials: row.credentials,
	};
}

/**
 * Resolve a project by its GitHub repository (`owner/repo`). Returns `undefined`
 * when no project owns that repo — a webhook for an unknown repo isn't an error,
 * it just isn't ours (ai/CODING_STANDARDS.md "Error handling").
 */
export async function findProjectByRepoFromDb(repo: string): Promise<ProjectConfig | undefined> {
	const rows = await getDb().select().from(projects).where(eq(projects.repo, repo)).limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
}

/**
 * Resolve a project by its GitHub Projects (v2) board node ID
 * (`githubProjects.projectId`, e.g. `PVT_kwHOAC3TF84BcNwD`). This is the PM-side
 * analogue of {@link findProjectByRepoFromDb}: a `projects_v2_item` webhook
 * carries the board node ID, not a repo, so the board mapping is how its SWARM
 * project is found. Matches inside the jsonb `github_projects` column via its
 * `projectId` key. Returns `undefined` for an untracked board — not our board
 * isn't an error (ai/CODING_STANDARDS.md "Error handling").
 */
export async function findProjectByBoardFromDb(
	projectNodeId: string,
): Promise<ProjectConfig | undefined> {
	const rows = await getDb()
		.select()
		.from(projects)
		.where(sql`${projects.githubProjects}->>'projectId' = ${projectNodeId}`)
		.limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
}

/** Resolve a project by its stable internal id. Returns `undefined` if unknown. */
export async function findProjectByIdFromDb(id: string): Promise<ProjectConfig | undefined> {
	const rows = await getDb().select().from(projects).where(eq(projects.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
}

/**
 * Upsert a project row from its `ProjectConfig` — the write side of the
 * config-file → DB loader (`swarm config apply`). Keyed on `id`, so re-applying
 * an edited `swarm.config.json` updates the existing row in place rather than
 * inserting a duplicate; the loader is idempotent by design.
 *
 * The `credentials` block is persisted as-is — it holds only *references*
 * (env-var keys), never the secrets themselves. The secret values are written
 * separately into `project_credentials` (see `credentialsRepository`).
 */
export async function upsertProjectToDb(config: ProjectConfig): Promise<void> {
	const values = {
		id: config.id,
		name: config.name,
		repo: config.repo,
		repoRoot: config.repoRoot,
		worktreeRoot: config.worktreeRoot,
		baseBranch: config.baseBranch,
		branchPrefix: config.branchPrefix,
		pmType: config.pm.type,
		githubProjects: config.githubProjects,
		credentials: config.credentials,
	};
	const { id: _id, ...updateValues } = values;
	await getDb()
		.insert(projects)
		.values(values)
		.onConflictDoUpdate({
			target: projects.id,
			set: { ...updateValues, updatedAt: new Date() },
		});
}
