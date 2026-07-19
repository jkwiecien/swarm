/**
 * Project **membership** — which SWARM users belong to a project and in what
 * role. The single source of truth for the shape (ai/CODING_STANDARDS.md "Zod is
 * the source of truth") and the second slice of the multi-user foundation
 * (ADR-001, issue #281): where `SwarmUser` (`./schema.ts`) models *who* a person
 * is on the installation, a membership models *what* they may do on one project.
 *
 * Provider-neutral, like the rest of the identity domain: a membership links a
 * SWARM user id to a `projects.id`, coupled to no SCM identity or IdP. Membership
 * here is created only directly (repository/CLI/admin) — open-project discovery
 * and a public join flow are a later #281 task, not this one.
 *
 * This slice is the **read model** authorization (a later #281 task) builds on —
 * the role predicates below name the access levels a future enforcement layer
 * checks; no router reads them yet.
 */

import { z } from 'zod';

/**
 * A user's role *on one project* — the per-project analogue of the
 * installation-level {@link import('./schema.js').InstallationRoleSchema}.
 * Exactly one of three, ordered by privilege (see {@link projectRoleRank}):
 *
 * - `projectAdmin` — administers the project: membership, config, credentials
 *   (implies write and read).
 * - `member` — a full working member: may act on the project / drive its runs
 *   (implies read).
 * - `contributor` — a limited participant: read-only visibility into the project
 *   and its runs.
 *
 * An installation admin (`instanceAdmin`, `./schema.ts`) overrides all of these
 * for every project; that override lives in the membership service, not here.
 */
export const ProjectRoleSchema = z.enum(['projectAdmin', 'member', 'contributor']);

export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/** Every project role, most-privileged first — for CLI usage/validation copy. */
export const PROJECT_ROLES = ProjectRoleSchema.options;

/**
 * A single project membership: one SWARM user in one role on one project.
 * `projectId` is a `projects.id` (`text`, externally supplied), `userId` is a
 * `users.id` (`uuid`, generated); `id` is the membership row's own generated
 * `uuid`. Unique per `(projectId, userId)` — a user holds at most one role per
 * project (enforced by the table's unique index, `src/db/schema/projectMembers.ts`).
 */
export const ProjectMembershipSchema = z.object({
	id: z.string().uuid(),
	projectId: z.string().min(1),
	userId: z.string().uuid(),
	role: ProjectRoleSchema,
	createdAt: z.date(),
});

export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;

/**
 * Privilege rank of a role — higher is more privileged. The single ordering the
 * predicates below derive from, so the role hierarchy is defined in exactly one
 * place. Extend alongside {@link ProjectRoleSchema} if more roles are added.
 */
const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
	contributor: 0,
	member: 1,
	projectAdmin: 2,
};

/** Privilege rank of a role (see {@link PROJECT_ROLE_RANK}). */
export function projectRoleRank(role: ProjectRole): number {
	return PROJECT_ROLE_RANK[role];
}

/** Whether `role` is at least as privileged as `minimum`. */
export function roleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
	return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[minimum];
}

/**
 * Access-level predicates — the named seams a future authorization layer checks,
 * rather than pattern-matching the raw role at every call site (mirroring
 * `isInstanceAdmin`, `./schema.ts`). Each takes a concrete `ProjectRole`; a
 * caller with *no* membership has no access, and the installation-admin override
 * is applied separately by the membership service.
 */
export function canAdministerProject(role: ProjectRole): boolean {
	return roleAtLeast(role, 'projectAdmin');
}

export function canWriteProject(role: ProjectRole): boolean {
	return roleAtLeast(role, 'member');
}

export function canReadProject(role: ProjectRole): boolean {
	return roleAtLeast(role, 'contributor');
}
