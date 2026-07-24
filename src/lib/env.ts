/**
 * Read a required environment variable, throwing if it is unset or empty.
 *
 * Missing required config is a programmer/deployment error, not a "not found"
 * lookup — so this throws rather than returning null (see ai/CODING_STANDARDS.md
 * "Error handling").
 */
export function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

/**
 * Read an optional environment variable, falling back to `fallback` when unset
 * or empty.
 */
export function optionalEnv(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === '' ? fallback : value;
}

/**
 * Whether SWARM's local single-user mode is enabled (`SWARM_SINGLE_USER_MODE`).
 *
 * A disabled-by-default API authentication policy for a local, single-operator
 * install (issue #298): when enabled the API resolves the bootstrapped
 * `localhost-admin` instead of requiring a dashboard session cookie. Only the
 * literal string `true` enables it — an unset, empty, or any other value keeps
 * the coded default (the existing multi-user, session-cookie behavior), so the
 * safe multi-user policy is what you get unless you opt in explicitly.
 */
export function isSingleUserMode(): boolean {
	return process.env.SWARM_SINGLE_USER_MODE === 'true';
}

/** How the host worker receives its work (`SWARM_DISPATCH_MODE`). */
export type DispatchMode = 'in-process' | 'transport';

/**
 * Resolve the host worker's dispatch mode (`SWARM_DISPATCH_MODE`, ADR-003 §2).
 *
 * `in-process` (the default, and what an unset/empty value keeps) runs today's
 * BullMQ consumer + `processJob` in this process. `transport` instead runs the
 * worker-side transport-dispatch client (`../worker/transport-client.ts`): the
 * worker connects to the control plane, receives pushed `TaskAssignment` frames,
 * and reports results back over the transport back-channel. Any other value
 * fails startup loudly rather than silently falling back, mirroring the other
 * worker env parsers. The mode is default-off until phase 4 wires the
 * control-plane sending side and flips the cutover.
 */
export function resolveDispatchMode(raw = process.env.SWARM_DISPATCH_MODE): DispatchMode {
	const value = (raw ?? '').trim();
	if (value === '' || value === 'in-process') return 'in-process';
	if (value === 'transport') return 'transport';
	throw new Error(`SWARM_DISPATCH_MODE must be 'in-process' or 'transport', got '${raw}'`);
}
