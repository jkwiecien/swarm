/**
 * DB-free discovery of the agent CLIs a remote daemon can actually run, used by
 * the worker transport client (`./worker-client.ts`) to declare its capabilities
 * at handshake. It probes the developer's PATH for each `AgentCli`'s binary — the
 * same set the harness knows how to launch (`../harness/agent-cli.ts`) — and
 * nothing more.
 *
 * The in-process host worker declares capabilities via `discoverCliQuotas`
 * (`../harness/quota-discovery.ts`), but that path reads the `runs` table for a
 * fallback rate-limit signal and so pulls in the DB client. A remote daemon holds
 * **only** its credential and the control-plane URL — no `DATABASE_URL` — so this
 * module deliberately reuses none of that: it depends on nothing under `../db/*`
 * or the queue, matching the transport client's no-datastore contract (ADR-003
 * §1). Availability here is the cheap "does the binary run" check alone; quota
 * telemetry rides the optional heartbeat health, not the capability set.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type AgentCli, AgentCliSchema } from '../harness/agent-cli.js';

const execFileAsync = promisify(execFile);

/**
 * Binary name per agent CLI. Antigravity's CLI binary is `agy`, not
 * `antigravity` (the enum value is SWARM's internal identifier, not the binary) —
 * the same mapping the harness and `discoverCliQuotas` use.
 */
const CLI_BINARY: Record<AgentCli, string> = {
	claude: 'claude',
	antigravity: 'agy',
	codex: 'codex',
};

/** How long a single `--version` probe may run before it is treated as absent. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether `command` exists and runs on PATH. A missing binary throws `ENOENT`
 * (→ `false`); a binary that exists but exits non-zero or lacks `--version` is
 * still present, so a fallback bare invocation confirms it. Mirrors
 * `isBinaryRunnable` in `../harness/quota-discovery.ts` without that module's DB
 * import.
 */
async function isBinaryRunnable(command: string): Promise<boolean> {
	try {
		await execFileAsync(command, ['--version'], { timeout: PROBE_TIMEOUT_MS });
		return true;
	} catch (err) {
		if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return false;
		try {
			await execFileAsync(command, [], { timeout: PROBE_TIMEOUT_MS });
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * The agent CLIs runnable on this host, probed by binary availability on PATH.
 * The set the daemon declares at handshake; empty when none are installed (the
 * entrypoint treats that as a clear startup error, since the handshake requires a
 * non-empty capability set).
 */
export async function discoverAvailableClis(): Promise<AgentCli[]> {
	const clis = AgentCliSchema.options;
	const available = await Promise.all(
		clis.map(async (cli) => ((await isBinaryRunnable(CLI_BINARY[cli])) ? cli : undefined)),
	);
	return available.filter((cli): cli is AgentCli => cli !== undefined);
}

/**
 * Parse an explicit `SWARM_WORKER_TRANSPORT_CLIS` override — a comma-separated
 * list of `AgentCli` values — into a validated, de-duplicated set. Returns
 * `undefined` when the raw value is empty (fall back to PATH discovery); throws on
 * any token that is not a known CLI, so a typo is a loud startup failure rather
 * than a silently narrowed capability set.
 */
export function parseDeclaredClisOverride(raw: string | undefined): AgentCli[] | undefined {
	if (!raw) return undefined;
	const tokens = raw
		.split(',')
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return undefined;
	const parsed = tokens.map((token) => {
		const result = AgentCliSchema.safeParse(token);
		if (!result.success) {
			throw new Error(
				`SWARM_WORKER_TRANSPORT_CLIS contains an unknown CLI '${token}'; valid values are ${AgentCliSchema.options.join(', ')}`,
			);
		}
		return result.data;
	});
	return [...new Set(parsed)];
}
