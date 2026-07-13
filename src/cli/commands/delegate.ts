/**
 * `swarm delegate <contract-file>` — the entry a pipeline primary agent invokes
 * to hand a bounded documentation edit to a curated, lighter-model child run
 * (docs/OPTIMIZATION.md §6 "Option B"). Not an operator command: it is called
 * *by the agent* from inside its worktree, reading the delegation policy SWARM
 * injected into its env (`src/delegation/native.ts` `configureDelegationRun`).
 *
 * It validates the contract, refuses nested delegation and the host kill switch,
 * launches the sandboxed child (`src/delegation/orchestrator.ts`), appends the
 * resulting observation to `.swarm-delegation-events.jsonl` for the worker to
 * pick up, prints the child's diff for the primary to inspect, and exits 0 on a
 * completed delegation or 2 on a rejected/failed one.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	DELEGATION_ENV,
	DELEGATION_EVENTS_FILENAME,
	DelegationContractSchema,
} from '@/delegation/native.js';
import { runDelegatedChild, validateContractPaths } from '@/delegation/orchestrator.js';
import { AgentCliSchema } from '@/harness/agent-cli.js';
import * as out from '../_shared/output.js';

const DEFAULT_MINIMUM_OPERATIONS = 3;

export async function run(argv: string[]): Promise<number> {
	const manifestPath = argv.find((arg) => !arg.startsWith('-'));
	if (!manifestPath) {
		out.error('usage: swarm delegate <contract-file>');
		return 2;
	}

	// A child launched by this command carries SWARM_DELEGATION_DEPTH=1; refusing
	// here is the recursion guard that keeps a delegation from spawning another.
	if (process.env[DELEGATION_ENV.depth] === '1') {
		out.error('nested delegation is prohibited: a delegation child cannot delegate again');
		return 2;
	}
	if (process.env[DELEGATION_ENV.killSwitch] === 'false') {
		out.error('delegation is disabled by the host kill switch');
		return 2;
	}

	const childCli = process.env[DELEGATION_ENV.childCli];
	const model = process.env[DELEGATION_ENV.childModel];
	if (!childCli || !model) {
		out.error('delegation is not enabled for this run (no curated child CLI/model configured)');
		return 2;
	}
	const cli = AgentCliSchema.parse(childCli);

	const rawMinimum = Number.parseInt(process.env[DELEGATION_ENV.minimumOperations] ?? '', 10);
	const minimumSemanticOperations = Number.isInteger(rawMinimum)
		? rawMinimum
		: DEFAULT_MINIMUM_OPERATIONS;

	const cwd = process.cwd();
	const contract = DelegationContractSchema.parse(
		JSON.parse(readFileSync(resolve(cwd, manifestPath), 'utf8')),
	);
	validateContractPaths(contract);

	const outcome = await runDelegatedChild({
		contract,
		cwd,
		cli,
		model,
		phase: process.env[DELEGATION_ENV.phase] ?? 'unknown',
		minimumSemanticOperations,
		parentRunId: process.env[DELEGATION_ENV.parentRunId] || undefined,
		parentSessionId: process.env[DELEGATION_ENV.parentSessionId] || undefined,
	});

	appendFileSync(
		resolve(cwd, DELEGATION_EVENTS_FILENAME),
		`${JSON.stringify(outcome.observation)}\n`,
	);
	out.info(outcome.report);
	return outcome.exitCode;
}
