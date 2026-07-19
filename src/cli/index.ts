/**
 * `swarm` — the operator/DX CLI (SWARM-22): init local config and manage the
 * local Docker stack (start/stop/status/logs).
 *
 * Unlike Cascade's `src/cli/` — a suite of agent-facing tools built on oclif —
 * this is a small, dependency-free dispatcher (Node's `util.parseArgs` +
 * `child_process`) because these are operator commands that mostly wrap
 * `docker compose`; oclif would be weight without benefit here. Each subcommand
 * lives in `commands/<name>.ts` and exports `run(argv): Promise<number>`, where
 * the number is the process exit code.
 */

import * as out from './_shared/output.js';
import * as config from './commands/config.js';
import * as init from './commands/init.js';
import * as logs from './commands/logs.js';
import * as members from './commands/members.js';
import * as queue from './commands/queue.js';
import * as start from './commands/start.js';
import * as status from './commands/status.js';
import * as stop from './commands/stop.js';
import * as users from './commands/users.js';
import * as worktrees from './commands/worktrees.js';

type Command = { run: (argv: string[]) => Promise<number> };

const COMMANDS: Record<string, Command> = {
	init,
	config,
	start,
	stop,
	status,
	logs,
	queue,
	users,
	members,
	worktrees,
};

const USAGE = `swarm — SWARM operator CLI

Usage: swarm <command> [options]

Commands:
  init             Bootstrap local config (.env + swarm.config.json)
  config apply     Load swarm.config.json into Postgres (projects + credentials)
  start [--build]  Start the local stack (postgres, redis, router)
  stop [-v]        Stop the stack (-v/--volumes also drops its volumes)
  status           Show stack container states and probe the router's health
  logs [svc] [-f]  Tail stack logs (optional service, -f/--follow to stream)
  queue clear      Remove all pending queue jobs (not active runs)
  users            Manage SWARM users and the installation admin
  members          Manage project membership (who belongs to a project)
  worktrees prune  Prune stale per-task worktrees

The worker is not managed here — it runs on the host: npm run dev:worker`;

/**
 * Parse argv (already stripped of `node` + script path) and run the matching
 * command. Returns the exit code; `--help`/no command prints usage and exits 0.
 */
export async function run(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;

	if (!command || command === '--help' || command === '-h' || command === 'help') {
		out.info(USAGE);
		return 0;
	}

	const handler = COMMANDS[command];
	if (!handler) {
		out.error(`unknown command '${command}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		return await handler.run(rest);
	} catch (err) {
		out.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

// Entrypoint guard: only self-run when invoked directly (via bin/swarm.js or the
// `swarm` npm script), never when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await run(process.argv.slice(2)));
}
