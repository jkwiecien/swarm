import { clearPendingJobs, closeQueue } from '../../queue/producer.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm queue — inspect and clear pending queue work

Usage: swarm queue clear

  clear  Remove all waiting, prioritized, and delayed jobs. Active jobs are not
         touched; stop the worker first if nothing should start while clearing.

Requires REDIS_URL in the environment — run via \`npm run queue:clear\` (loads
.env) or export it yourself first.`;

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		return subcommand ? 0 : 1;
	}

	if (subcommand !== 'clear' || rest.length > 0) {
		out.error(`unknown queue subcommand '${[subcommand, ...rest].join(' ')}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		const removed = await clearPendingJobs();
		out.info(`cleared ${removed} pending queue job${removed === 1 ? '' : 's'}`);
		return 0;
	} catch (err) {
		out.error(`queue clear failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		await closeQueue();
	}
}
