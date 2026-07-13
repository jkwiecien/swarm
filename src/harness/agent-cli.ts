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

import type { DelegationObservation } from '@/delegation/native.js';
import { readDelegationObservations } from '@/delegation/observations.js';
import { logger } from '@/lib/logger.js';
import { detectNewConversationId, snapshotConversationIds } from './antigravity-session.js';
import { type AgentUsage, parseAgentOutput } from './usage.js';

/** Agent CLIs the harness knows how to launch. Source of truth for the set. */
export const AgentCliSchema = z.enum(['claude', 'antigravity', 'codex']);
export type AgentCli = z.infer<typeof AgentCliSchema>;

/**
 * Human-readable "cli (model)" label for a phase's start-of-run log line, e.g.
 * `antigravity (Gemini 3.5 Flash (High))`. Omits the parens entirely when no
 * model override is set, rather than naming the CLI's own default — the
 * harness never queries what that default resolves to (see `model` on
 * {@link RunAgentCliOptions}), so there's nothing accurate to print.
 */
export function describeAgent(cli: AgentCli, model?: string): string {
	return model ? `${cli} (${model})` : cli;
}

/**
 * Default binary name per agent CLI; override per call via `command`.
 * Antigravity's actual CLI binary is `agy`, not `antigravity` — the enum value
 * above is SWARM's internal identifier for the harness, not the binary name.
 * Codex's binary is `codex`.
 */
const DEFAULT_COMMAND: Record<AgentCli, string> = {
	claude: 'claude',
	antigravity: 'agy',
	codex: 'codex',
};

/**
 * Flags prepended ahead of every caller's own `args` (the prompt), so no phase
 * has to remember them. Every run through this harness happens inside a
 * disposable git worktree with stdin closed (`stdio: ['ignore', ...]` below)
 * — there is no terminal to approve a tool call, so without
 * a permissions-bypass flag a run that needs to write a file or run a
 * command sits blocked on a permission prompt it can never receive. Confirmed
 * live: a Planning run produced a complete plan, then reported the write to
 * `proposed_plan.md` as "blocked pending your permission approval" in its
 * final response and exited 0 having written nothing.
 *
 * claude and agy both call their bypass `--dangerously-skip-permissions`.
 * Codex calls it `--dangerously-bypass-approvals-and-sandbox` (confirmed via
 * `codex exec --help`; it has no `--dangerously-skip-permissions` at all).
 *
 * claude and agy also expose a `-p`/`--print` flag for one-shot,
 * non-interactive output (`claude --help`: "starts an interactive session by
 * default, use -p/--print for non-interactive output"; `agy --help` has the
 * identical flag name). But the two parsers treat it differently: claude's
 * `-p` is a bare boolean — the prompt is a separate positional argument, so
 * `-p`'s position relative to other flags doesn't matter. agy's
 * `-p`/`--print`/`--prompt` is a *value* flag whose value is the prompt
 * itself — confirmed live: an Implementation run on `agy -p
 * --dangerously-skip-permissions --model <m> "<the real prompt>"` had `-p`
 * swallow the literal string `--dangerously-skip-permissions` as its prompt,
 * ran a one-off Q&A about that flag, and exited 0 having done none of the
 * actual task. So `-p` must be the *last* flag, immediately before the
 * prompt, for claude and agy — safe for claude (position-independent) and
 * required for agy.
 *
 * Codex is different again: it has no `-p` print flag at all. Its `-p` is
 * `--profile` (layer a config profile), entirely unrelated. Non-interactive
 * mode is the `exec` subcommand — `codex exec <prompt>`, where the prompt is
 * a trailing positional argument. So `DEFAULT_ARGS['codex']` starts with
 * `'exec'` to invoke the subcommand, and `PRINT_FLAG['codex']` is an empty
 * string (nothing to insert before the prompt). See PRINT_FLAG below;
 * don't add a fourth CLI's flags to this map without checking its own
 * `--help`, not assuming it matches another CLI's (ai/RULES.md).
 */
const DEFAULT_ARGS: Record<AgentCli, string[]> = {
	claude: ['--dangerously-skip-permissions'],
	antigravity: ['--dangerously-skip-permissions'],
	codex: ['exec', '--dangerously-bypass-approvals-and-sandbox'],
};

/**
 * The non-interactive-mode flag, inserted immediately before the prompt (see
 * DEFAULT_ARGS above for why the position is load-bearing for agy).
 *
 * Codex has no print flag — non-interactive mode is via the `exec` subcommand
 * (already in DEFAULT_ARGS), so PRINT_FLAG is empty for it. The assembly
 * logic in `runAgentCli` filters out empty strings, so no stray '' arg leaks
 * into the spawn call.
 */
const PRINT_FLAG: Record<AgentCli, string> = {
	claude: '-p',
	antigravity: '-p',
	codex: '',
};

/**
 * Per-CLI flag(s) requesting machine-readable output, inserted after
 * `modelArgs` and before `PRINT_FLAG`/the prompt — never between `PRINT_FLAG`
 * and the prompt, which is the only position load-bearing for agy (see
 * PRINT_FLAG above), so this map is safe to extend without disturbing that.
 *
 * `claude --help`: combined with `-p`, `--output-format json` emits a single
 * JSON object on stdout — `{ result: <final text>, usage: {...}, ... }` —
 * instead of the plain final-text stdout `-p` alone produces. The harness
 * parses that JSON (`./usage.js`) to recover both the same human-readable
 * text the log viewer showed before this feature (`.result`) and per-run
 * token usage (`.usage`), so switching Claude to JSON output is invisible to
 * the log viewer.
 *
 * `codex exec --json` emits JSONL events; `./usage.js` extracts the final
 * `turn.completed` usage and readable agent-message text. Antigravity has no
 * structured-output or usage flag (verified via `agy --help` and a live run),
 * so it stays on the graceful-unavailable path. Its empty entry also preserves
 * the load-bearing `-p`-immediately-before-prompt order described above.
 */
const OUTPUT_FORMAT_ARGS: Record<AgentCli, string[]> = {
	claude: ['--output-format', 'json'],
	antigravity: [],
	codex: ['--json'],
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
	/** Provider-specific flags inserted before output/session/print arguments. */
	providerArgs?: string[];
	/**
	 * Model for this session, passed as `--model <value>` — both `claude` and
	 * `agy` accept an alias (`sonnet`, `opus`) or a full model name. Omit to run
	 * on the CLI's own default; the harness doesn't validate the value against a
	 * fixed list, since the two CLIs' model names don't overlap.
	 */
	model?: string;
	/**
	 * Session UUID to *assign* to a fresh run. Only `claude` supports assigning
	 * an id up front (`--session-id`); `codex` and `agy` generate their own, so
	 * this is ignored for them (their id is captured post-run into
	 * {@link AgentCliResult.sessionId} instead). Mutually exclusive with
	 * {@link resumeSessionId} — a run either starts fresh or resumes.
	 */
	sessionId?: string;
	/**
	 * Existing session/thread id to *resume*, threaded into the CLI's own resume
	 * mechanism: `claude --resume <id>`, `agy --conversation <id>`, or
	 * `codex exec resume <id>` (a subcommand, not a flag — see the assembly in
	 * {@link runAgentCli}). Ignored when {@link sessionId} is also set.
	 */
	resumeSessionId?: string;
	/** Extra env vars, merged over (and overriding) the parent process env. */
	env?: Record<string, string>;
	/** Override the binary to launch — mainly for tests/deployment. Defaults per `cli`. */
	command?: string;
	/** Called once per complete stdout line as it streams in. */
	onStdout?: (line: string) => void;
	/** Called once per complete stderr line as it streams in. */
	onStderr?: (line: string) => void;
	/**
	 * Cap on how many bytes of stdout/stderr are retained in the returned result
	 * (each stream counted independently). Once a stream crosses the cap the
	 * captured buffer stops growing and `outputTruncated` is set; the per-line
	 * `onStdout`/`onStderr` callbacks keep firing regardless, so a caller that
	 * streams output is unaffected. Omit for unbounded capture — sensible for
	 * short runs, but the worker (SWARM-17) driving long, chatty agents should
	 * set this to bound memory.
	 */
	maxOutputBytes?: number;
	/**
	 * Echo every output line to the logger at `debug`. Off by default: the logger
	 * has no level gating (see src/lib/logger.ts), so leaving this on floods the
	 * daemon console for a verbose agent. Opt in when debugging a run; production
	 * callers consume output via the `onStdout`/`onStderr` callbacks instead.
	 */
	logLines?: boolean;
	/**
	 * Extra fields merged into this run's `agent run finished` log line. The
	 * harness is generic — it doesn't know which task/phase it's serving — so a
	 * caller that runs concurrently with other phases (the worker, with
	 * `SWARM_WORKER_CONCURRENCY > 1`) passes `{ taskId, phase, … }` here so its
	 * finish line is attributable in an interleaved log. Without it, two phases'
	 * `agent run finished` lines are indistinguishable and read as an out-of-order
	 * pipeline (the "review before implementation" false alarm this closes).
	 */
	logContext?: Record<string, unknown>;
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
	/**
	 * True when `timeoutMs` elapsed and the run was killed for it. Authoritative
	 * on the timeout having fired; if a process happens to exit on its own at the
	 * same instant the timeout elapses this can still read `true` (the deadline
	 * genuinely passed), so don't treat it as "the timeout is the sole reason the
	 * process is gone".
	 */
	timedOut: boolean;
	/**
	 * True when the run was killed because the caller's `signal` fired (never set
	 * by `timeoutMs` — see {@link timedOut} for that case). This is the harness's
	 * only way to tell "the caller cancelled this deliberately" apart from "the
	 * process exited on its own for some other reason": the two can look
	 * identical downstream (an aborted `claude`/`agy` run has been observed to
	 * exit 143 with `signal: null`, trapping SIGTERM and calling `process.exit`
	 * itself rather than being torn down by the OS). Callers that classify
	 * failures (`src/harness/agent-failure.ts`) need this to avoid treating a
	 * worker-shutdown-induced abort as an unexplained agent error.
	 */
	aborted: boolean;
	/**
	 * True when `maxOutputBytes` was hit and `stdout`/`stderr` below were
	 * truncated. The per-line callbacks still saw the full stream.
	 */
	outputTruncated: boolean;
	/**
	 * The CLI session/thread id this run used, to `--resume` it later. Captured
	 * per CLI: `claude` echoes it in its JSON output (and SWARM assigned it via
	 * `--session-id`), `codex` emits it as its `thread.started` event, and
	 * `antigravity` is recovered out-of-band by diffing its conversation store
	 * ({@link ./antigravity-session.ts}). Absent when the CLI produced no
	 * recoverable id — an unsupported/older CLI, malformed output, or a run that
	 * never got far enough to create a session.
	 */
	sessionId?: string;
	/**
	 * Normalized token usage extracted from this run's stdout (`./usage.js`),
	 * or `undefined` when the CLI/output didn't yield any — an unsupported CLI
	 * (Antigravity cannot report it), malformed output, or a run that never
	 * produced output at all. A truncated run (`outputTruncated`) can still
	 * report usage: the trailing usage summary is recovered from the retained
	 * tail of stdout, unless it too was cut off.
	 */
	usage?: AgentUsage;
	/** Native child-agent lifecycle and usage records linked to this parent run. */
	delegations?: DelegationObservation[];
}

/**
 * Accumulate stream chunks into a single string, capped at `maxBytes`. Once the
 * cap is crossed the buffer stops growing and `truncated` latches — bounding
 * memory for a runaway, chatty agent without disturbing the line callbacks that
 * consume the live stream elsewhere.
 */
function cappedBuffer(maxBytes: number | undefined) {
	let text = '';
	let bytes = 0;
	let truncated = false;
	return {
		add(chunk: string): void {
			if (truncated) return;
			text += chunk;
			if (maxBytes !== undefined) {
				bytes += Buffer.byteLength(chunk);
				if (bytes >= maxBytes) truncated = true;
			}
		},
		get text(): string {
			return text;
		},
		get truncated(): boolean {
			return truncated;
		},
	};
}

/**
 * Rolling buffer that retains only the last `maxBytes` of a stream, dropping
 * the oldest chunks as newer ones arrive. Where {@link cappedBuffer} keeps the
 * *head* (the display log, latched once full), this keeps the *tail* — the one
 * place a CLI reports token usage (claude's final JSON, codex's trailing
 * `turn.completed` event). It lets a run that floods the head cap — e.g. a
 * large test suite printing ~1MB — still recover its usage summary, which is
 * always emitted last. `undefined` maxBytes means the head buffer already
 * captured everything, so the tail is left empty (unused).
 */
function tailBuffer(maxBytes: number | undefined) {
	const chunks: string[] = [];
	let bytes = 0;
	return {
		add(chunk: string): void {
			if (maxBytes === undefined) return;
			chunks.push(chunk);
			bytes += Buffer.byteLength(chunk);
			while (bytes > maxBytes && chunks.length > 1) {
				bytes -= Buffer.byteLength(chunks[0]);
				chunks.shift();
			}
		},
		get text(): string {
			return chunks.join('');
		},
	};
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
/**
 * The base subcommand args plus the resume/assign session flags for one run,
 * per CLI (ai/RULES.md §6: the three CLIs don't share resume shapes):
 *  - codex resumes via a *subcommand* — `codex exec resume <id> …` — so a resume
 *    rewrites the base `exec` args entirely (keeping the bypass flag), and adds
 *    no separate session flag;
 *  - claude/agy resume via a *flag* (`--resume` / `--conversation`) inserted
 *    after the output-format flags, leaving their base args unchanged;
 *  - a resume id always wins over an assign id — a run either continues an
 *    existing session or starts a fresh one, never both.
 */
function buildSessionArgs(
	cli: AgentCli,
	resumeId: string | undefined,
	assignId: string | undefined,
): { baseArgs: string[]; sessionArgs: string[] } {
	if (cli === 'codex') {
		return {
			baseArgs: resumeId
				? ['exec', 'resume', resumeId, '--dangerously-bypass-approvals-and-sandbox']
				: DEFAULT_ARGS.codex,
			sessionArgs: [],
		};
	}
	if (cli === 'claude') {
		const sessionArgs = resumeId
			? ['--resume', resumeId]
			: assignId
				? ['--session-id', assignId]
				: [];
		return { baseArgs: DEFAULT_ARGS.claude, sessionArgs };
	}
	// antigravity: resume by conversation id; no assign-upfront flag exists.
	return {
		baseArgs: DEFAULT_ARGS.antigravity,
		sessionArgs: resumeId ? ['--conversation', resumeId] : [],
	};
}

export async function runAgentCli(options: RunAgentCliOptions): Promise<AgentCliResult> {
	const cli = AgentCliSchema.parse(options.cli);
	const command = options.command ?? DEFAULT_COMMAND[cli];
	const modelArgs = options.model ? ['--model', options.model] : [];
	const resumeId = options.resumeSessionId;
	const { baseArgs, sessionArgs } = buildSessionArgs(cli, resumeId, options.sessionId);
	const printFlag = PRINT_FLAG[cli];
	const args = [
		...baseArgs,
		...modelArgs,
		...(options.providerArgs ?? []),
		...OUTPUT_FORMAT_ARGS[cli],
		...sessionArgs,
		...(printFlag ? [printFlag] : []),
		...(options.args ?? []),
	];
	const start = Date.now();

	// Antigravity neither assigns nor prints its conversation id, so capture it by
	// diffing its on-disk conversation store around the run. Snapshot the "before"
	// set here (synchronously, immediately before spawn) so the "after" diff in the
	// close handler attributes only this run's new conversation. A resume run
	// reuses the existing conversation and creates no new file — its id is
	// `resumeId`, so we skip the snapshot entirely in that case.
	const antigravityBefore =
		cli === 'antigravity' && !resumeId ? snapshotConversationIds() : undefined;

	return new Promise<AgentCliResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const stdout = cappedBuffer(options.maxOutputBytes);
		const stderr = cappedBuffer(options.maxOutputBytes);
		// Retains the tail of stdout so a trailing usage summary survives even when
		// the head-capped `stdout` buffer truncates (see {@link tailBuffer}).
		const stdoutTail = tailBuffer(options.maxOutputBytes);
		let timedOut = false;
		let aborted = false;
		let killRequested = false;
		let settled = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let graceTimer: NodeJS.Timeout | undefined;

		const forwardStdout = lineForwarder((line) => {
			if (options.logLines) logger.debug('agent stdout', { cli, line });
			options.onStdout?.(line);
		});
		const forwardStderr = lineForwarder((line) => {
			if (options.logLines) logger.debug('agent stderr', { cli, line });
			options.onStderr?.(line);
		});

		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			stdout.add(chunk);
			stdoutTail.add(chunk);
			forwardStdout.push(chunk);
		});
		child.stderr?.on('data', (chunk: string) => {
			stderr.add(chunk);
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

		const onAbort = (): void => {
			aborted = true;
			killChild();
		};
		if (options.signal) {
			if (options.signal.aborted) onAbort();
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
			// A CLI reports token usage at the very END of its output. When a chatty
			// run floods the head-capped `stdout` buffer, that trailing summary is
			// dropped from `stdout.text` — but the rolling `stdoutTail` still holds
			// it, so parse usage from the tail in that case (a big test suite exiting
			// 0 would otherwise lose its usage). `stdoutTail.text` is the last
			// `maxOutputBytes`, so it starts mid-line/mid-JSON; only usage is trusted
			// from it — the run's log stays the (truncated) head text. A
			// non-truncated run parses the full text as before.
			const parsed = stdout.truncated
				? parseAgentOutput(cli, stdoutTail.text)
				: parseAgentOutput(cli, stdout.text);
			// Resolve the resumable session id per CLI. claude/codex emit it in
			// their output (`parsed.sessionId`); claude also falls back to the id
			// SWARM assigned/resumed with, in case an older build omits it.
			// Antigravity has no output id, so diff its conversation store — or, on a
			// resume run, keep the id we resumed with.
			const sessionId = resolveSessionId(parsed.sessionId);
			// Scope delegation observations by parent run id only — the SWARM-controlled
			// key the `swarm delegate` command stamps. When it's absent (the no-DB path
			// where no run row exists, so SWARM_PARENT_RUN_ID is empty), the read falls
			// through to unscoped, so a completed-but-unreviewed delegation is still
			// caught rather than silently dropped by a session-id filter it never set.
			const delegations = readDelegationObservations(options.cwd, {
				parentRunId: options.env?.SWARM_PARENT_RUN_ID,
			});
			const result: AgentCliResult = {
				cli,
				exitCode: code,
				signal,
				stdout: stdout.truncated ? stdout.text : (parsed.logText ?? stdout.text),
				stderr: stderr.text,
				durationMs: Date.now() - start,
				timedOut,
				aborted,
				outputTruncated: stdout.truncated || stderr.truncated,
				usage: parsed.usage,
				sessionId,
				delegations: delegations.length > 0 ? delegations : undefined,
			};
			logger.debug('agent run finished', {
				...options.logContext,
				cli,
				exitCode: result.exitCode,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut,
				aborted,
				outputTruncated: result.outputTruncated,
				sessionId,
			});
			resolve(result);
		});

		/** Per-CLI resolution of the id to resume this run with (see close handler). */
		function resolveSessionId(parsedSessionId?: string): string | undefined {
			if (cli === 'claude') return parsedSessionId ?? resumeId ?? options.sessionId;
			if (cli === 'antigravity') {
				if (resumeId) return resumeId;
				return antigravityBefore ? detectNewConversationId(antigravityBefore) : undefined;
			}
			// codex: `thread.started` re-emits the same id on resume, so the parsed
			// value already reflects a resumed session; fall back to resumeId if the
			// event was missed (e.g. truncated head with no tail recovery).
			return parsedSessionId ?? resumeId;
		}
	});
}
