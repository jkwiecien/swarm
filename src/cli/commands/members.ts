/**
 * `swarm members` — the operator front-door onto project membership (#281 task
 * 3). It lets an admin seed who belongs to a project, and in what role, before
 * the dashboard membership UI exists — the membership-side companion to
 * `swarm users` (`commands/users.ts`).
 *
 * A thin file/CLI shell over `projectMembersRepository.ts` (`node:util`
 * `parseArgs` + `_shared/output.ts`, like `commands/users.ts`), resolving users
 * by their login handle and projects by id so operators work in the identifiers
 * they know rather than raw uuids. The DB pool is closed in a `finally`
 * (`closeDb()`).
 *
 * Subcommands:
 *   swarm members add <project-id> <user-identifier> [--role <role>]
 *   swarm members list <project-id>
 *   swarm members set-role <project-id> <user-identifier> --role <role>
 *   swarm members remove <project-id> <user-identifier>
 */

import { parseArgs } from 'node:util';
import { closeDb } from '../../db/client.js';
import {
	addMember,
	listMembersForProject,
	removeMember,
	updateMemberRole,
} from '../../db/repositories/projectMembersRepository.js';
import { findProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { findUserByIdentifier, getUserById } from '../../db/repositories/usersRepository.js';
import { PROJECT_ROLES, type ProjectRole, ProjectRoleSchema } from '../../identity/membership.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm members — manage project membership (who belongs to a project, in what role)

Usage:
  swarm members add <project-id> <user-identifier> [--role <role>]
  swarm members list <project-id>
  swarm members set-role <project-id> <user-identifier> --role <role>
  swarm members remove <project-id> <user-identifier>

  add        Add a user (by login handle) to a project. --role is one of
             ${PROJECT_ROLES.join(' | ')} (default: member).
  list       List a project's members ('<identifier>\\t<role>' per line).
  set-role   Change an existing member's role.
  remove     Remove a user from a project.

Roles, most to least privileged: projectAdmin (administer) > member (write) >
contributor (read). Requires DATABASE_URL. Membership is not yet enforced by any
router — it is the read model authorization will build on.`;

/**
 * A duplicate `(project, user)` surfaces the pg `23505` unique violation, which
 * drizzle-orm wraps in an error whose original pg error (carrying `code`) is on
 * `.cause` — mirrors the check in `commands/users.ts`.
 */
function hasUniqueViolationCode(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === '23505'
	);
}

function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}

/** Validate a role string against `ProjectRoleSchema`, printing a friendly error on failure. */
function parseRole(raw: string): ProjectRole | undefined {
	const parsed = ProjectRoleSchema.safeParse(raw);
	if (!parsed.success) {
		out.error(`invalid role '${raw}' — must be one of: ${PROJECT_ROLES.join(', ')}`);
		return undefined;
	}
	return parsed.data;
}

async function addMembership(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { role: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const [projectId, identifier] = positionals;
	if (!projectId || !identifier) {
		out.error('members add: <project-id> and <user-identifier> are required');
		out.info(USAGE);
		return 1;
	}

	const role = parseRole(values.role ?? 'member');
	if (!role) return 1;

	const project = await findProjectByIdFromDb(projectId);
	if (!project) {
		out.error(`no project with id '${projectId}'`);
		return 1;
	}
	const user = await findUserByIdentifier(identifier);
	if (!user) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	try {
		await addMember({ projectId, userId: user.id, role });
		out.info(`added '${identifier}' to '${projectId}' as ${role}`);
		return 0;
	} catch (err) {
		if (isUniqueViolation(err)) {
			out.error(
				`'${identifier}' is already a member of '${projectId}' (use set-role to change their role)`,
			);
			return 1;
		}
		throw err;
	}
}

async function listMembers(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const projectId = positionals[0];
	if (!projectId) {
		out.error('members list: a <project-id> is required');
		out.info(USAGE);
		return 1;
	}

	const members = await listMembersForProject(projectId);
	if (members.length === 0) {
		out.info(`no members for '${projectId}'`);
		return 0;
	}
	for (const member of members) {
		const user = await getUserById(member.userId);
		out.info(`${user ? user.identifier : member.userId}\t${member.role}`);
	}
	return 0;
}

async function setRole(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { role: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const [projectId, identifier] = positionals;
	if (!projectId || !identifier) {
		out.error('members set-role: <project-id> and <user-identifier> are required');
		out.info(USAGE);
		return 1;
	}
	if (!values.role) {
		out.error('members set-role: --role <role> is required');
		out.info(USAGE);
		return 1;
	}
	const role = parseRole(values.role);
	if (!role) return 1;

	const user = await findUserByIdentifier(identifier);
	if (!user) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	const updated = await updateMemberRole(user.id, projectId, role);
	if (!updated) {
		out.error(`'${identifier}' is not a member of '${projectId}'`);
		return 1;
	}
	out.info(`set '${identifier}' role on '${projectId}' to ${role}`);
	return 0;
}

async function removeMembership(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const [projectId, identifier] = positionals;
	if (!projectId || !identifier) {
		out.error('members remove: <project-id> and <user-identifier> are required');
		out.info(USAGE);
		return 1;
	}

	const user = await findUserByIdentifier(identifier);
	if (!user) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	const removed = await removeMember(user.id, projectId);
	if (!removed) {
		out.error(`'${identifier}' is not a member of '${projectId}'`);
		return 1;
	}
	out.info(`removed '${identifier}' from '${projectId}'`);
	return 0;
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		// No subcommand is a usage error; an explicit --help is not.
		return subcommand ? 0 : 1;
	}

	if (!['add', 'list', 'set-role', 'remove'].includes(subcommand)) {
		out.error(`unknown members subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		switch (subcommand) {
			case 'add':
				return await addMembership(rest);
			case 'list':
				return await listMembers(rest);
			case 'set-role':
				return await setRole(rest);
			default:
				return await removeMembership(rest);
		}
	} finally {
		await closeDb();
	}
}
