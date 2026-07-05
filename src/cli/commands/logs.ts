/**
 * `swarm logs [service] [--follow]` — tail the stack's container logs. An
 * optional service name (`postgres`, `redis`, `router`) scopes it to one
 * container; `--follow`/`-f` streams new lines until interrupted.
 */

import { parseArgs } from 'node:util';
import { runCommand } from '../_shared/exec.js';
import { REPO_ROOT } from '../_shared/paths.js';

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { follow: { type: 'boolean', short: 'f', default: false } },
		allowPositionals: true,
	});

	const composeArgs = ['compose', 'logs'];
	if (values.follow) {
		composeArgs.push('--follow');
	}
	composeArgs.push(...positionals);

	return runCommand('docker', composeArgs, { cwd: REPO_ROOT });
}
