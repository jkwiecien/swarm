/**
 * `swarm stop` — tear down the local stack. By default the postgres/redis
 * volumes are preserved (so project config and run history survive a restart);
 * `--volumes`/`-v` drops them for a clean slate.
 */

import { parseArgs } from 'node:util';
import { runCommand } from '../_shared/exec.js';
import * as out from '../_shared/output.js';
import { REPO_ROOT } from '../_shared/paths.js';

export async function run(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: { volumes: { type: 'boolean', short: 'v', default: false } },
		allowPositionals: false,
	});

	const composeArgs = ['compose', 'down'];
	if (values.volumes) {
		composeArgs.push('--volumes');
	}

	out.step(
		values.volumes
			? 'stopping the local stack and removing its volumes…'
			: 'stopping the local stack (volumes preserved)…',
	);
	return runCommand('docker', composeArgs, { cwd: REPO_ROOT });
}
