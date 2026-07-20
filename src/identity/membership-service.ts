/**
 * Provider-neutral **membership read model** — the thin domain surface later
 * phases consume (authorization enforcement, dashboard project screens; #281
 * tasks 4/5) so they never touch the `project_members` table directly. The
 * membership-side companion to the identity read model (`./service.ts`) and the
 * second slice of the multi-user foundation (ADR-001, issue #281).
 *
 * Reads only — creating/updating/removing memberships is an operator action
 * exposed through the `swarm members` CLI over `projectMembersRepository.ts`;
 * this service stays the read-side seam callers program against. The role
 * predicates (`canAdministerProject`/`canWriteProject`/`canReadProject`) are
 * re-exported from `./membership.ts` so a caller has one import for the whole
 * read model.
 */

import {
	getMembership as getMembershipRow,
	listMembersForProject as listMembersForProjectRows,
	listProjectsForUser as listProjectsForUserRows,
} from '../db/repositories/projectMembersRepository.js';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import type { ProjectMembership } from './membership.js';
import { isInstanceAdmin } from './service.js';

export {
	canAdministerProject,
	canReadProject,
	canWriteProject,
	type ProjectMembership,
	type ProjectRole,
} from './membership.js';

/** A user's membership of one project, or `undefined` if they are not a member. */
export async function getMembership(
	userId: string,
	projectId: string,
): Promise<ProjectMembership | undefined> {
	return getMembershipRow(userId, projectId);
}

/** Every membership of a project (empty if it has no members). */
export async function listMembersForProject(projectId: string): Promise<ProjectMembership[]> {
	return listMembersForProjectRows(projectId);
}

/** Every project membership a user holds (empty if they belong to no project). */
export async function listProjectsForUser(userId: string): Promise<ProjectMembership[]> {
	return listProjectsForUserRows(userId);
}

/**
 * The set of project ids a user may access — the read model authorization
 * builds on. An installation admin (`isInstanceAdmin`, `./service.ts`) accesses
 * *every* project, so this returns all project ids; any other user accesses only
 * the projects they are a member of. Ids are returned de-duplicated and sorted
 * for a stable, comparable result.
 */
export async function listAccessibleProjectIds(userId: string): Promise<string[]> {
	if (await isInstanceAdmin(userId)) {
		const projects = await listAllProjectsFromDb();
		return projects.map((project) => project.id).sort();
	}
	const memberships = await listProjectsForUserRows(userId);
	return [...new Set(memberships.map((membership) => membership.projectId))].sort();
}
