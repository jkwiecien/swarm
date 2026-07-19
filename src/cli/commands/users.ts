/**
 * `swarm users` — the operator front-door onto the SWARM user identity model
 * (#281 task 1). Without a way to create the first user the model is inert, so
 * this ships the minimal operator command that makes it usable — the analogue of
 * `swarm config apply` being the front-door onto `applyConfig`.
 *
 * A thin file/CLI shell over `usersRepository.ts` (`node:util` `parseArgs` +
 * `_shared/output.ts`, like `commands/config.ts`). No secrets are handled here —
 * session auth (passwords/tokens) is #281 task 2 — so nothing is logged that
 * shouldn't be. The DB pool is closed in a `finally` (`closeDb()`).
 *
 * Subcommands:
 *   swarm users add <identifier> [--name <displayName>] [--admin]
 *   swarm users list
 *   swarm users grant-admin <identifier>
 *   swarm users revoke-admin <identifier>
 */

import { parseArgs } from 'node:util';
import { closeDb } from '../../db/client.js';
import {
	createUser,
	findUserByIdentifier,
	listUsers,
	setInstanceAdmin,
} from '../../db/repositories/usersRepository.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm users — manage SWARM users and the installation admin

Usage:
  swarm users add <identifier> [--name <displayName>] [--admin]
  swarm users list
  swarm users grant-admin <identifier>
  swarm users revoke-admin <identifier>

  add            Create a user with the given login handle (username/email).
                 --name sets the display name (defaults to the identifier);
                 --admin designates the user an installation admin.
  list           List all users, one per line.
  grant-admin    Make an existing user an installation admin.
  revoke-admin   Remove a user's installation-admin role.

Requires DATABASE_URL in the environment — run via a wrapper that loads .env, or
export it yourself first. These rows are not yet used by the running auth path
(the dashboard stays behind DASHBOARD_TOKEN); they sit ready for session auth.`;

/**
 * A duplicate `identifier` surfaces the pg `23505` unique violation, which
 * drizzle-orm wraps in a `DrizzleQueryError` whose original pg error (carrying
 * `code`) is on `.cause` — mirrors the check in `api/routers/projects.ts`.
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

async function addUser(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			name: { type: 'string' },
			admin: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const identifier = positionals[0];
	if (!identifier) {
		out.error('users add: an <identifier> is required');
		out.info(USAGE);
		return 1;
	}

	try {
		const user = await createUser({
			identifier,
			displayName: values.name ?? identifier,
			instanceAdmin: values.admin ?? false,
		});
		out.info(`created user '${user.identifier}'${user.instanceAdmin ? ' (instance admin)' : ''}`);
		return 0;
	} catch (err) {
		if (isUniqueViolation(err)) {
			out.error(`a user with identifier '${identifier}' already exists`);
			return 1;
		}
		throw err;
	}
}

async function listAllUsers(): Promise<number> {
	const users = await listUsers();
	if (users.length === 0) {
		out.info('no users');
		return 0;
	}
	for (const user of users) {
		out.info(`${user.identifier}\t${user.displayName}${user.instanceAdmin ? '\t[admin]' : ''}`);
	}
	return 0;
}

async function setAdminFlag(argv: string[], value: boolean): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const identifier = positionals[0];
	if (!identifier) {
		out.error(`users ${value ? 'grant-admin' : 'revoke-admin'}: an <identifier> is required`);
		out.info(USAGE);
		return 1;
	}

	const existing = await findUserByIdentifier(identifier);
	if (!existing) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	await setInstanceAdmin(existing.id, value);
	out.info(`${value ? 'granted' : 'revoked'} instance admin for '${identifier}'`);
	return 0;
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		// No subcommand is a usage error; an explicit --help is not.
		return subcommand ? 0 : 1;
	}

	if (!['add', 'list', 'grant-admin', 'revoke-admin'].includes(subcommand)) {
		out.error(`unknown users subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		switch (subcommand) {
			case 'add':
				return await addUser(rest);
			case 'list':
				return await listAllUsers();
			case 'grant-admin':
				return await setAdminFlag(rest, true);
			default:
				return await setAdminFlag(rest, false);
		}
	} finally {
		await closeDb();
	}
}
