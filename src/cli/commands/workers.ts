/**
 * `swarm workers` — the operator front-door onto the registered-worker identity
 * model (#132 Phase 1). It lets an owner register the local machines they run
 * agent CLIs on, and declare which CLIs each supports, before any dashboard
 * worker UI exists — the worker-side companion to `swarm users`
 * (`commands/users.ts`) and `swarm members` (`commands/members.ts`).
 *
 * A thin file/CLI shell over `identity/worker-service.ts` (+ the repository's
 * `removeWorker`), using `node:util` `parseArgs` + `_shared/output.ts` like
 * `commands/members.ts`, resolving owners by their login handle so operators work
 * in the identifiers they know rather than raw uuids. The DB pool is closed in a
 * `finally` (`closeDb()`).
 *
 * The one secret it handles is the **worker credential**: `register` prints it
 * exactly once with a "store it now" note (analogous to `swarm users
 * set-password` never echoing a stored secret), and it is never shown again — no
 * subcommand prints a credential or its hash.
 *
 * Subcommands:
 *   swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
 *   swarm workers list [<owner-identifier>]
 *   swarm workers set-cli <worker-id> --cli <c1,c2,...>
 *   swarm workers remove <worker-id>
 */

import { parseArgs } from 'node:util';
import { closeDb } from '../../db/client.js';
import { findUserByIdentifier, listUsers } from '../../db/repositories/usersRepository.js';
import { removeWorker } from '../../db/repositories/workersRepository.js';
import { type AgentCli, AgentCliSchema } from '../../harness/agent-cli.js';
import type { Worker } from '../../identity/worker.js';
import {
	listWorkersForOwner,
	refreshWorkerCapabilities,
	registerWorker,
} from '../../identity/worker-service.js';
import * as out from '../_shared/output.js';

const AGENT_CLIS = AgentCliSchema.options;

const USAGE = `swarm workers — register and manage local workers (identity + declared CLIs)

Usage:
  swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
  swarm workers list [<owner-identifier>]
  swarm workers set-cli <worker-id> --cli <c1,c2,...>
  swarm workers remove <worker-id>

  register   Register a worker for an owner (by login handle) with a display
             name and declared CLIs (--cli, comma-separated, one or more of
             ${AGENT_CLIS.join(' | ')}). Prints a worker credential ONCE — store
             it then, it is never shown again.
  list       List workers ('<id>\\t<displayName>\\t<clis>' per line). With an
             owner identifier, only that owner's; without, all owners' (prefixed
             with the owner identifier). Never prints a credential or its hash.
  set-cli    Replace a worker's declared CLIs by worker id.
  remove     Deregister a worker by worker id.

Requires DATABASE_URL. A worker is a local execution environment owned by a
SWARM user; it is inert until worker sessions and project enrollment consume it.`;

const SUBCOMMANDS = ['register', 'list', 'set-cli', 'remove'];

/**
 * A duplicate `(owner, displayName)` surfaces the pg `23505` unique violation,
 * which drizzle-orm wraps in an error whose original pg error (carrying `code`)
 * is on `.cause` — mirrors the check in `commands/members.ts`.
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

/**
 * Parse a comma-separated `--cli` value into a validated `AgentCli[]`, printing a
 * friendly error and returning `undefined` on an empty list or unknown value. The
 * service re-validates and de-dupes; this just gives the operator a clear message
 * before a write is attempted.
 */
function parseClis(raw: string) {
	const parts = raw
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) {
		out.error('--cli must list at least one CLI');
		return undefined;
	}
	const clis: AgentCli[] = [];
	for (const part of parts) {
		const parsed = AgentCliSchema.safeParse(part);
		if (!parsed.success) {
			out.error(`invalid CLI '${part}' — must be one of: ${AGENT_CLIS.join(', ')}`);
			return undefined;
		}
		clis.push(parsed.data);
	}
	return clis;
}

async function registerWorkerCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			name: { type: 'string' },
			cli: { type: 'string' },
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
		out.error('workers register: an <owner-identifier> is required');
		out.info(USAGE);
		return 1;
	}
	if (!values.name) {
		out.error('workers register: --name <displayName> is required');
		out.info(USAGE);
		return 1;
	}
	if (!values.cli) {
		out.error('workers register: --cli <c1,c2,...> is required');
		out.info(USAGE);
		return 1;
	}

	const capabilities = parseClis(values.cli);
	if (!capabilities) return 1;

	const owner = await findUserByIdentifier(identifier);
	if (!owner) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	try {
		const { worker, credential } = await registerWorker({
			ownerUserId: owner.id,
			displayName: values.name,
			capabilities,
		});
		out.info(
			`registered worker '${worker.displayName}' for '${identifier}' (id ${worker.id}, CLIs: ${worker.capabilities.join(', ')})`,
		);
		out.info('worker credential (store it now — it will not be shown again):');
		out.info(credential);
		return 0;
	} catch (err) {
		if (isUniqueViolation(err)) {
			out.error(`a worker named '${values.name}' already exists for '${identifier}'`);
			return 1;
		}
		throw err;
	}
}

/** Print one worker line, optionally prefixed with its owner identifier. Never prints the credential. */
function printWorker(worker: Worker, ownerIdentifier?: string): void {
	const prefix = ownerIdentifier ? `${ownerIdentifier}\t` : '';
	out.info(`${prefix}${worker.id}\t${worker.displayName}\t${worker.capabilities.join(',')}`);
}

async function listWorkersCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const identifier = positionals[0];

	if (identifier) {
		const owner = await findUserByIdentifier(identifier);
		if (!owner) {
			out.error(`no user with identifier '${identifier}'`);
			return 1;
		}
		const workers = await listWorkersForOwner(owner.id);
		if (workers.length === 0) {
			out.info(`no workers for '${identifier}'`);
			return 0;
		}
		for (const worker of workers) printWorker(worker);
		return 0;
	}

	// No owner given: list every owner's workers, prefixed with the owner
	// identifier (resolved via listUsers, like `members list` resolves ids).
	const users = await listUsers();
	let printed = 0;
	for (const user of users) {
		const workers = await listWorkersForOwner(user.id);
		for (const worker of workers) {
			printWorker(worker, user.identifier);
			printed += 1;
		}
	}
	if (printed === 0) out.info('no workers');
	return 0;
}

async function setCliCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { cli: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const workerId = positionals[0];
	if (!workerId) {
		out.error('workers set-cli: a <worker-id> is required');
		out.info(USAGE);
		return 1;
	}
	if (!values.cli) {
		out.error('workers set-cli: --cli <c1,c2,...> is required');
		out.info(USAGE);
		return 1;
	}

	const capabilities = parseClis(values.cli);
	if (!capabilities) return 1;

	const updated = await refreshWorkerCapabilities(workerId, capabilities);
	if (!updated) {
		out.error(`no worker with id '${workerId}'`);
		return 1;
	}
	out.info(
		`set CLIs for worker '${updated.displayName}' (${workerId}) to ${updated.capabilities.join(', ')}`,
	);
	return 0;
}

async function removeWorkerCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const workerId = positionals[0];
	if (!workerId) {
		out.error('workers remove: a <worker-id> is required');
		out.info(USAGE);
		return 1;
	}

	const removed = await removeWorker(workerId);
	if (!removed) {
		out.error(`no worker with id '${workerId}'`);
		return 1;
	}
	out.info(`removed worker '${workerId}'`);
	return 0;
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		// No subcommand is a usage error; an explicit --help is not.
		return subcommand ? 0 : 1;
	}

	if (!SUBCOMMANDS.includes(subcommand)) {
		out.error(`unknown workers subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		switch (subcommand) {
			case 'register':
				return await registerWorkerCommand(rest);
			case 'list':
				return await listWorkersCommand(rest);
			case 'set-cli':
				return await setCliCommand(rest);
			default:
				return await removeWorkerCommand(rest);
		}
	} finally {
		await closeDb();
	}
}
