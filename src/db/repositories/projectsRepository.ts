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

import { asc, eq, sql } from 'drizzle-orm';

import type { ProjectConfig } from '../../config/schema.js';
import { getDb } from '../client.js';
import { projectMembers } from '../schema/projectMembers.js';
import { projects } from '../schema/projects.js';
import type { AddMemberInput } from './projectMembersRepository.js';

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
		maxConcurrentJobs: row.maxConcurrentJobs,
		pm: { type: row.pmType as 'github-projects' },
		githubProjects: row.githubProjects,
		credentials: row.credentials,
		agents: row.agents ?? undefined,
		pipeline: row.pipeline ?? undefined,
		worktreeRetention: row.worktreeRetention ?? undefined,
	};
}

/** Flatten a `ProjectConfig` into the columns needed for insertion/upsertion. */
function projectConfigToRow(config: ProjectConfig) {
	return {
		id: config.id,
		name: config.name,
		repo: config.repo,
		repoRoot: config.repoRoot,
		worktreeRoot: config.worktreeRoot,
		baseBranch: config.baseBranch,
		branchPrefix: config.branchPrefix,
		maxConcurrentJobs: config.maxConcurrentJobs,
		pmType: config.pm.type,
		githubProjects: config.githubProjects,
		credentials: config.credentials,
		agents: config.agents ?? null,
		pipeline: config.pipeline ?? null,
		worktreeRetention: config.worktreeRetention ?? null,
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
	const values = projectConfigToRow(config);
	const { id: _id, ...updateValues } = values;
	await getDb()
		.insert(projects)
		.values(values)
		.onConflictDoUpdate({
			target: projects.id,
			set: { ...updateValues, updatedAt: new Date() },
		});
}

/**
 * Create a new project row in the DB.
 * Unlike `upsertProjectToDb`, this rejects with a unique constraint violation if the ID already exists.
 */
export async function createProjectInDb(config: ProjectConfig): Promise<void> {
	const values = projectConfigToRow(config);
	await getDb().insert(projects).values(values);
}

/**
 * Create a new project row and insert the creator's owner membership atomically in one database transaction.
 * If either insert fails, the whole transaction rolls back so a failed membership insert never leaves an unowned project row.
 */
export async function createProjectWithMemberInDb(
	config: ProjectConfig,
	member: AddMemberInput,
): Promise<void> {
	const values = projectConfigToRow(config);
	await getDb().transaction(async (tx) => {
		await tx.insert(projects).values(values);
		await tx.insert(projectMembers).values({
			projectId: member.projectId,
			userId: member.userId,
			role: member.role,
		});
	});
}

/**
 * Delete a project from the DB by its ID.
 * Because of the `ON DELETE CASCADE` foreign key on `project_credentials.project_id`,
 * this will also automatically delete all related credentials.
 */
export async function deleteProjectFromDb(id: string): Promise<void> {
	await getDb().delete(projects).where(eq(projects.id, id));
}

/**
 * List all projects in the DB, ordered by name.
 */
export async function listAllProjectsFromDb(): Promise<ProjectConfig[]> {
	const rows = await getDb().select().from(projects).orderBy(asc(projects.name));
	return rows.map(rowToProjectConfig);
}

export { findProjectByIdFromDb as getProjectByIdFromDb };
