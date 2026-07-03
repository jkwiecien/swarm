/**
 * Agent-CLI execution engine.
 *
 * Given a worktree directory and which agent CLI to run, spawn the CLI as a
 * child process with the worktree as its CWD, stream its stdout/stderr, and
 * capture the exit code. This is the "agent execution" half of Phase 3 — the
 * worker (SWARM-17) provisions a worktree (SWARM-14/15) and then calls this;
 * prompt construction, persona/token wiring, and queue consumption all live
 * elsewhere.
 *
 * Built on Node's `child_process.spawn` rather than a subprocess library:
 * SWARM keeps its dependency set small, and "spawn a binary, stream its output,
 * read its exit code" is exactly what the built-in covers.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';

import { logger } from '@/lib/logger.js';

/** Agent CLIs the harness knows how to launch. Source of truth for the set. */
export const AgentCliSchema = z.enum(['claude', 'antigravity']);
export type AgentCli = z.infer<typeof AgentCliSchema>;

/** Default binary name per agent CLI; override per call via `command`. */
const DEFAULT_COMMAND: Record<AgentCli, string> = {
	claude: 'claude',
	antigravity: 'antigravity',
};

/**
 * How long to wait after SIGTERM before escalating to SIGKILL when a run is
 * killed by `timeoutMs` or an aborted `signal`. Agent CLIs may need a moment to
 * flush/clean up; SIGKILL is the backstop if they ignore SIGTERM.
 */
const KILL_GRACE_MS = 5_000;

export interface RunAgentCliOptions {
	/** Which agent CLI to launch. */
	cli: AgentCli;
	/** Worktree directory — becomes the child process CWD. */
	cwd: string;
	/** Arguments passed to the CLI (prompt, flags, …). */
	args?: string[];
	/** Extra env vars, merged over (and overriding) the parent process env. */
	env?: Record<string, string>;
	/** Override the binary to launch — mainly for tests/deployment. Defaults per `cli`. */
	command?: string;
	/** Called once per complete stdout line as it streams in. */
	onStdout?: (line: string) => void;
	/** Called once per complete stderr line as it streams in. */
	onStderr?: (line: string) => void;
	/** Kill the run if it exceeds this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the child. */
	signal?: AbortSignal;
}

export interface AgentCliResult {
	cli: AgentCli;
	/** Exit code, or null when the process was terminated by a signal. */
	exitCode: number | null;
	/** Terminating signal, or null on a normal exit. */
	signal: NodeJS.Signals | null;
	/** Full captured stdout/stderr (also delivered line-by-line via callbacks). */
	stdout: string;
	stderr: string;
	/** Wall-clock duration of the run, in ms. */
	durationMs: number;
	/** True when the run was killed because `timeoutMs` elapsed. */
	timedOut: boolean;
}

/**
 * Split an incoming stream of chunks into complete lines, invoking `onLine` for
 * each. Partial lines are buffered until the next chunk (or `flush()` at close),
 * and a trailing `\r` (CRLF) is stripped so callers see clean lines.
 */
function lineForwarder(onLine: (line: string) => void) {
	let buffer = '';
	return {
		push(chunk: string): void {
			buffer += chunk;
			let idx = buffer.indexOf('\n');
			while (idx !== -1) {
				onLine(buffer.slice(0, idx).replace(/\r$/, ''));
				buffer = buffer.slice(idx + 1);
				idx = buffer.indexOf('\n');
			}
		},
		flush(): void {
			if (buffer.length > 0) {
				onLine(buffer.replace(/\r$/, ''));
				buffer = '';
			}
		},
	};
}

/**
 * Spawn an agent CLI in the given worktree, stream its output, and resolve with
 * the captured result.
 *
 * A non-zero exit code is a normal outcome (the agent ran and failed) and is
 * returned in the result for the caller to act on — it is *not* thrown. A spawn
 * failure (e.g. ENOENT because the CLI isn't installed) is a deployment/config
 * error and rejects the promise, per ai/CODING_STANDARDS.md "Error handling".
 */
export async function runAgentCli(options: RunAgentCliOptions): Promise<AgentCliResult> {
	const cli = AgentCliSchema.parse(options.cli);
	const command = options.command ?? DEFAULT_COMMAND[cli];
	const args = options.args ?? [];
	const start = Date.now();

	return new Promise<AgentCliResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let killRequested = false;
		let settled = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let graceTimer: NodeJS.Timeout | undefined;

		const forwardStdout = lineForwarder((line) => {
			logger.debug('agent stdout', { cli, line });
			options.onStdout?.(line);
		});
		const forwardStderr = lineForwarder((line) => {
			logger.debug('agent stderr', { cli, line });
			options.onStderr?.(line);
		});

		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			stdout += chunk;
			forwardStdout.push(chunk);
		});
		child.stderr?.on('data', (chunk: string) => {
			stderr += chunk;
			forwardStderr.push(chunk);
		});

		// SIGTERM first, then SIGKILL after a grace period if it's ignored. Guarded
		// so a timeout racing with an abort only schedules one escalation.
		const killChild = (): void => {
			if (killRequested) return;
			killRequested = true;
			child.kill('SIGTERM');
			graceTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
		};

		if (options.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				killChild();
			}, options.timeoutMs);
		}

		const onAbort = (): void => killChild();
		if (options.signal) {
			if (options.signal.aborted) killChild();
			else options.signal.addEventListener('abort', onAbort, { once: true });
		}

		const cleanup = (): void => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener('abort', onAbort);
		};

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`Failed to launch ${cli} ("${command}"): ${err.message}`));
		});

		child.on('close', (code, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			forwardStdout.flush();
			forwardStderr.flush();
			const result: AgentCliResult = {
				cli,
				exitCode: code,
				signal,
				stdout,
				stderr,
				durationMs: Date.now() - start,
				timedOut,
			};
			logger.info('agent run finished', {
				cli,
				exitCode: result.exitCode,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut,
			});
			resolve(result);
		});
	});
}
