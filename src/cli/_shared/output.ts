/**
 * Human-facing output for the `swarm` operator CLI.
 *
 * Cascade's agent-tool CLIs emit JSON to stdout (`src/cli/_shared/output.ts`)
 * because a machine consumes them. These commands are the opposite: a developer
 * runs them interactively and the interesting output is the child process's own
 * stream (`docker compose …`), so the CLI's own lines stay plain and prefixed.
 */

const PREFIX = 'swarm';

export function info(message: string): void {
	console.log(`${PREFIX}: ${message}`);
}

export function step(message: string): void {
	console.log(`${PREFIX}: → ${message}`);
}

export function warn(message: string): void {
	console.warn(`${PREFIX}: ${message}`);
}

export function error(message: string): void {
	console.error(`${PREFIX}: ${message}`);
}
