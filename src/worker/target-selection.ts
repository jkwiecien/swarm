/**
 * Capability-aware routing of a phase's ordered model targets (issue #346).
 *
 * `agents.<phase>.targets` (`src/config/schema.ts`) is a priority list — index 0
 * is the phase's preferred CLI/model/reasoning combination. This picks the
 * highest-priority target whose CLI *this worker can actually run*, so a phase
 * configured for a CLI that isn't installed here still runs — on the next target
 * this machine can serve — instead of failing on spawn.
 *
 * Scope: one local worker choosing among its own installed CLIs. The federated
 * multi-worker scheduler from ADR-001 (assignee affinity, worker enrollment,
 * deferring until a capable worker is free) is a separate concern.
 */

import type { AgentTarget } from '../config/schema.js';
import { getAllCliQuotas } from '../db/repositories/cliQuotasRepository.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * The CLIs this worker can run, or `undefined` when that is unknown — an unknown
 * answer routes to the preferred target rather than to "nothing is available".
 */
export type WorkerCliAvailability = ReadonlySet<AgentCli> | undefined;

/** Which of a phase's targets the worker routed to, and what it had to skip. */
export type TargetSelection = {
	/** The chosen target — its `cli`/`model`/`reasoning` drive the run. */
	target: AgentTarget;
	/** Its index in the phase's priority list (0 = the preferred target). */
	index: number;
	/** CLIs of the higher-priority targets skipped as unrunnable on this worker. */
	skipped: AgentCli[];
	/**
	 * No target's CLI is available here, so the preferred one was used anyway —
	 * preserving the pre-routing behaviour of failing visibly on spawn. A phase is
	 * never silently skipped for want of a CLI.
	 */
	fallback: boolean;
};

/**
 * Pick the highest-priority target this worker can run. Pure: the availability
 * set is resolved once per job by {@link loadAvailableClis} and passed in.
 *
 * Returns `undefined` when the phase configured no targets at all (it stays on
 * its coded defaults, and the caller keeps reading the single-selection mirror).
 */
export function selectTarget(
	targets: AgentTarget[] | undefined,
	availableClis: WorkerCliAvailability,
): TargetSelection | undefined {
	if (!targets || targets.length === 0) return undefined;
	const preferred = targets[0];
	// Capabilities unknown — keep the pre-routing behaviour and run the preferred target.
	if (!availableClis) return { target: preferred, index: 0, skipped: [], fallback: false };
	const skipped: AgentCli[] = [];
	for (const [index, target] of targets.entries()) {
		// A target with no `cli` runs on the phase's own coded default CLI, which
		// this list can't name and so has no availability signal — always eligible.
		if (!target.cli || availableClis.has(target.cli)) {
			return { target, index, skipped, fallback: false };
		}
		skipped.push(target.cli);
	}
	return { target: preferred, index: 0, skipped: [], fallback: true };
}

/**
 * Best-effort snapshot of the CLIs this worker can run: the `cli_quotas` rows
 * capability discovery writes (`src/harness/quota-discovery.ts`). A CLI counts
 * as available unless it was discovered `unavailable` (an `error` snapshot means
 * the binary ran but its quota query didn't, so it can still take work).
 *
 * Returns `undefined` when the answer is unknown — the lookup failed, or
 * discovery has never run — so routing degrades to the preferred target instead
 * of concluding that nothing is runnable. Never throws: routing is an
 * optimization, and a DB hiccup must not fail a real run (the same best-effort
 * contract `loadGlobalDefaults` follows in `src/worker/consumer.ts`).
 */
export async function loadAvailableClis(): Promise<WorkerCliAvailability> {
	try {
		const snapshots = await getAllCliQuotas();
		if (snapshots.length === 0) return undefined;
		return new Set(snapshots.filter((s) => s.status !== 'unavailable').map((s) => s.cli));
	} catch (err) {
		logger.error('Failed to load CLI availability (routing to the preferred target)', {
			error: describeError(err),
		});
		return undefined;
	}
}
