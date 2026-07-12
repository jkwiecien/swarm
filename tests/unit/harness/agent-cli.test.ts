import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the subprocess boundary — unit tests never spawn a real CLI
// (ai/TESTING.md "mock … LLM CLI subprocess calls"). The fake child lets each
// test drive stdout/stderr, close, and error events deterministically.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { type AgentCliResult, describeAgent, runAgentCli } from '@/harness/agent-cli.js';
import { logger } from '@/lib/logger.js';
import { createMockRunAgentCliOptions } from '../../helpers/factories.js';

class FakeStream extends EventEmitter {
	setEncoding(): void {}
}

class FakeChild extends EventEmitter {
	stdout = new FakeStream();
	stderr = new FakeStream();
	kill = vi.fn();
}

let children: FakeChild[] = [];
const lastChild = (): FakeChild => {
	const child = children.at(-1);
	if (!child) throw new Error('spawn was not called');
	return child;
};

beforeEach(() => {
	children = [];
	spawnMock.mockReset();
	spawnMock.mockImplementation(() => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
});

describe('runAgentCli', () => {
	it('spawns the CLI in the worktree and captures stdout, stderr, and exit code', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions());
		const child = lastChild();
		child.stdout.emit('data', 'hello\nworld\n');
		child.stderr.emit('data', 'a warning\n');
		child.emit('close', 0, null);

		const result = await promise;
		expect(result).toMatchObject<Partial<AgentCliResult>>({
			cli: 'claude',
			exitCode: 0,
			signal: null,
			// Not valid JSON, so it falls back to the raw captured text unchanged.
			stdout: 'hello\nworld\n',
			stderr: 'a warning\n',
			timedOut: false,
			aborted: false,
			outputTruncated: false,
			usage: undefined,
		});

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			['--dangerously-skip-permissions', '--output-format', 'json', '-p'],
			{
				cwd: '/wt',
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
	});

	it('puts -p immediately before the caller-supplied prompt for claude', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions({ args: ['implement the thing'] }));
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			['--dangerously-skip-permissions', '--output-format', 'json', '-p', 'implement the thing'],
			expect.anything(),
		);
	});

	it('assigns and resumes Claude sessions before -p without affecting other CLIs', async () => {
		const fresh = runAgentCli(
			createMockRunAgentCliOptions({
				sessionId: '11111111-1111-4111-8111-111111111111',
				args: ['go'],
			}),
		);
		lastChild().emit('close', 0, null);
		await fresh;
		expect(spawnMock.mock.calls[0][1]).toEqual([
			'--dangerously-skip-permissions',
			'--output-format',
			'json',
			'--session-id',
			'11111111-1111-4111-8111-111111111111',
			'-p',
			'go',
		]);

		const resumed = runAgentCli(
			createMockRunAgentCliOptions({
				resumeSessionId: '11111111-1111-4111-8111-111111111111',
				args: ['continue'],
			}),
		);
		lastChild().emit('close', 0, null);
		await resumed;
		expect(spawnMock.mock.calls[1][1]).toContain('--resume');
		expect(spawnMock.mock.calls[1][1].slice(-2)).toEqual(['-p', 'continue']);
	});

	it('requests each supported structured output while leaving antigravity plain', async () => {
		const claude = runAgentCli(createMockRunAgentCliOptions());
		lastChild().emit('close', 0, null);
		await claude;
		expect(spawnMock.mock.calls[0][1]).toContain('--output-format');

		const agy = runAgentCli(createMockRunAgentCliOptions({ cli: 'antigravity' }));
		lastChild().emit('close', 0, null);
		await agy;
		expect(spawnMock.mock.calls[1][1]).not.toContain('--output-format');
		expect(spawnMock.mock.calls[1][1]).not.toContain('--json');

		const codex = runAgentCli(createMockRunAgentCliOptions({ cli: 'codex' }));
		lastChild().emit('close', 0, null);
		await codex;
		expect(spawnMock.mock.calls[2][1]).toContain('--json');
		expect(spawnMock.mock.calls[2][1]?.[0]).toBe('exec');
	});

	it('spawns the agy binary for antigravity, with -p immediately before the prompt too', async () => {
		// Load-bearing order: agy's -p/--print is a *value* flag whose value is the
		// prompt itself (unlike claude's boolean -p), confirmed live — see the
		// DEFAULT_ARGS/PRINT_FLAG comment in agent-cli.ts. Any flag landing between
		// -p and the prompt gets swallowed as the prompt instead of the real task.
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'antigravity', args: ['do the thing'] }),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'agy',
			['--dangerously-skip-permissions', '-p', 'do the thing'],
			expect.anything(),
		);
	});

	it('spawns codex with exec subcommand, --dangerously-bypass-approvals-and-sandbox, and no -p flag', async () => {
		// Codex's non-interactive mode is `codex exec <prompt>` (a subcommand, not
		// a -p flag — codex's -p is --profile, completely unrelated). Its permissions
		// bypass is --dangerously-bypass-approvals-and-sandbox (not
		// --dangerously-skip-permissions). Confirmed via `codex exec --help`.
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'codex', args: ['do the thing'] }),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', 'do the thing'],
			expect.anything(),
		);
	});

	it('inserts --model between the default flags and -p for claude, never between -p and the prompt', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ model: 'sonnet', args: ['implement the thing'] }),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			[
				'--dangerously-skip-permissions',
				'--model',
				'sonnet',
				'--output-format',
				'json',
				'-p',
				'implement the thing',
			],
			expect.anything(),
		);
	});

	it('inserts --model before the prompt for codex without a -p flag', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'codex',
				model: 'gpt-5.6-sol',
				args: ['implement the thing'],
			}),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			[
				'exec',
				'--dangerously-bypass-approvals-and-sandbox',
				'--model',
				'gpt-5.6-sol',
				'--json',
				'implement the thing',
			],
			expect.anything(),
		);
	});

	it('omits --model entirely when no model is specified', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions({ args: ['implement the thing'] }));
		lastChild().emit('close', 0, null);
		await promise;

		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).not.toContain('--model');
	});

	it('forwards output line-by-line, including partial and CRLF lines', async () => {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'antigravity',
				onStdout: (line) => stdoutLines.push(line),
				onStderr: (line) => stderrLines.push(line),
			}),
		);
		const child = lastChild();
		// Split mid-line across chunks; the buffer should stitch it back together.
		child.stdout.emit('data', 'first\r\nseco');
		child.stdout.emit('data', 'nd\nno-newline-yet');
		child.stderr.emit('data', 'err-line\n');
		child.emit('close', 0, null);

		await promise;
		// CRLF stripped, the split "second" reassembled, trailing partial flushed on close.
		expect(stdoutLines).toEqual(['first', 'second', 'no-newline-yet']);
		expect(stderrLines).toEqual(['err-line']);
	});

	it('returns a non-zero exit code rather than throwing', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions());
		const child = lastChild();
		child.stderr.emit('data', 'boom\n');
		child.emit('close', 2, null);

		const result = await promise;
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe('boom\n');
	});

	it('rejects when the CLI fails to spawn (e.g. not installed)', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions());
		lastChild().emit('error', new Error('spawn claude ENOENT'));

		await expect(promise).rejects.toThrow(
			/Failed to launch claude \("claude"\): spawn claude ENOENT/,
		);
	});

	it('passes through args, a custom command, and merges env over process.env', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				command: '/usr/bin/fake-claude',
				args: ['--print', 'do the thing'],
				env: { SWARM_TASK: '42' },
			}),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const [command, args, opts] = spawnMock.mock.calls[0] as [
			string,
			string[],
			{ env: Record<string, string> },
		];
		expect(command).toBe('/usr/bin/fake-claude');
		expect(args).toEqual([
			'--dangerously-skip-permissions',
			'--output-format',
			'json',
			'-p',
			'--print',
			'do the thing',
		]);
		expect(opts.env.SWARM_TASK).toBe('42');
		expect(opts.env.PATH).toBe(process.env.PATH);
	});

	it('rejects on an unknown CLI', async () => {
		// @ts-expect-error — exercising runtime validation with an invalid value
		await expect(runAgentCli({ cli: 'aider', cwd: '/wt' })).rejects.toThrow();
	});

	it('caps captured output at maxOutputBytes while still streaming every line', async () => {
		const lines: string[] = [];
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ maxOutputBytes: 5, onStdout: (line) => lines.push(line) }),
		);
		const child = lastChild();
		child.stdout.emit('data', 'aaa\n'); // 4 bytes — under the cap
		child.stdout.emit('data', 'bbbbbb\n'); // crosses the cap; retained, then latches
		child.stdout.emit('data', 'ccc\n'); // dropped from the captured buffer
		child.emit('close', 0, null);

		const result = await promise;
		expect(result.stdout).toBe('aaa\nbbbbbb\n');
		expect(result.outputTruncated).toBe(true);
		// The line callbacks are unaffected by the cap — they saw the full stream.
		expect(lines).toEqual(['aaa', 'bbbbbb', 'ccc']);
	});

	describe('usage extraction', () => {
		it('parses Claude JSON output into usage, and swaps stdout for the readable result text', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions());
			const child = lastChild();
			child.stdout.emit(
				'data',
				JSON.stringify({
					result: 'All done, implemented the feature.',
					usage: { input_tokens: 100, output_tokens: 50 },
				}),
			);
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
			expect(result.stdout).toBe('All done, implemented the feature.');
		});

		it('parses Codex JSONL usage and swaps stdout for the agent message', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ cli: 'codex' }));
			const child = lastChild();
			child.stdout.emit(
				'data',
				[
					'{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}',
					'{"type":"turn.completed","usage":{"input_tokens":12201,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
				].join('\n'),
			);
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toEqual({
				inputTokens: 12201,
				outputTokens: 5,
				cacheReadTokens: 9984,
				reasoningTokens: 0,
			});
			expect(result.stdout).toBe('pong');
		});

		it('leaves usage undefined and stdout raw for non-JSON stdout', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions());
			const child = lastChild();
			child.stdout.emit('data', 'plain text, not JSON\n');
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toBeUndefined();
			expect(result.stdout).toBe('plain text, not JSON\n');
		});

		it('leaves usage undefined when the trailing summary itself was cut off by truncation', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ maxOutputBytes: 5 }));
			const child = lastChild();
			// The JSON blob arrives across chunks larger than the tail budget, so the
			// tail retains only its final fragment — unparseable, so usage stays absent.
			child.stdout.emit('data', '{"result":"x",'); // latches head truncation
			child.stdout.emit('data', '"usage":{"input_tokens":1,"output_tokens":2}}');
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.outputTruncated).toBe(true);
			expect(result.usage).toBeUndefined();
		});

		it('leaves Codex usage undefined when its trailing event was cut off by truncation', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cli: 'codex', maxOutputBytes: 10 }),
			);
			const child = lastChild();
			// Same for a Codex event split across chunks past the tail budget: the tail
			// holds a bare fragment with no `turn.completed` line, so nothing parses.
			child.stdout.emit('data', '{"type":"turn.completed","usage":');
			child.stdout.emit('data', '{"input_tokens":1,"output_tokens":2}}');
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.outputTruncated).toBe(true);
			expect(result.usage).toBeUndefined();
		});

		it('recovers Codex usage from the tail when earlier output floods the cap', async () => {
			// Simulates the real failure: a large test suite floods the head buffer
			// (latching truncation), but the small trailing `turn.completed` event —
			// emitted last — still fits within the retained tail and yields usage.
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cli: 'codex', maxOutputBytes: 100 }),
			);
			const child = lastChild();
			child.stdout.emit('data', `${'x'.repeat(200)}\n`); // floods the head cap
			child.stdout.emit(
				'data',
				'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n',
			);
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.outputTruncated).toBe(true);
			expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
			// The stored log stays the truncated head — only usage comes from the tail.
			expect(result.stdout).toBe(`${'x'.repeat(200)}\n`);
		});
	});

	it('does not echo output lines to the logger by default, but does when logLines is set', async () => {
		const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
		try {
			const quiet = runAgentCli(createMockRunAgentCliOptions());
			const quietChild = lastChild();
			quietChild.stdout.emit('data', 'quiet line\n');
			quietChild.emit('close', 0, null);
			await quiet;
			// The per-line echo must be silent by default. (The run-summary debug line,
			// "agent run finished", is a separate concern and may fire either way.)
			expect(debugSpy).not.toHaveBeenCalledWith('agent stdout', expect.anything());
			expect(debugSpy).not.toHaveBeenCalledWith('agent stderr', expect.anything());

			const loud = runAgentCli(createMockRunAgentCliOptions({ logLines: true }));
			const loudChild = lastChild();
			loudChild.stdout.emit('data', 'loud line\n');
			loudChild.emit('close', 0, null);
			await loud;
			expect(debugSpy).toHaveBeenCalledWith('agent stdout', { cli: 'claude', line: 'loud line' });
		} finally {
			debugSpy.mockRestore();
		}
	});

	it('merges logContext into the "agent run finished" line so concurrent runs are attributable', async () => {
		const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
		try {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					logContext: { taskId: '42', phase: 'review', prNumber: '42' },
				}),
			);
			lastChild().emit('close', 0, null);
			await promise;

			expect(debugSpy).toHaveBeenCalledWith(
				'agent run finished',
				expect.objectContaining({ taskId: '42', phase: 'review', prNumber: '42', cli: 'claude' }),
			);
		} finally {
			debugSpy.mockRestore();
		}
	});

	describe('termination', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it('kills on timeout and reports timedOut, escalating to SIGKILL after the grace period', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ timeoutMs: 1_000 }));
			const child = lastChild();

			vi.advanceTimersByTime(1_000);
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			// CLI ignores SIGTERM past the grace period → SIGKILL.
			vi.advanceTimersByTime(5_000);
			expect(child.kill).toHaveBeenCalledWith('SIGKILL');

			child.emit('close', null, 'SIGKILL');
			const result = await promise;
			expect(result.timedOut).toBe(true);
			expect(result.aborted).toBe(false);
			expect(result.exitCode).toBeNull();
			expect(result.signal).toBe('SIGKILL');
		});

		it('kills when the abort signal fires, reporting aborted without marking it as a timeout', async () => {
			const controller = new AbortController();
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: controller.signal }));
			const child = lastChild();

			controller.abort();
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			child.emit('close', null, 'SIGTERM');
			const result = await promise;
			expect(result.timedOut).toBe(false);
			expect(result.aborted).toBe(true);
			expect(result.signal).toBe('SIGTERM');
		});

		it('reports aborted even when the CLI traps SIGTERM and exits cleanly with no signal', async () => {
			// Confirmed live (issue: worker --watch restart mid-review): claude
			// exited 143 with signal=null instead of being torn down by the OS —
			// classification must not depend on `signal` being non-null.
			const controller = new AbortController();
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: controller.signal }));
			const child = lastChild();

			controller.abort();
			child.emit('close', 143, null);
			const result = await promise;
			expect(result.aborted).toBe(true);
			expect(result.signal).toBeNull();
			expect(result.exitCode).toBe(143);
		});

		it('kills immediately when given an already-aborted signal', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: AbortSignal.abort() }));
			const child = lastChild();
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			child.emit('close', null, 'SIGTERM');
			const result = await promise;
			expect(result.aborted).toBe(true);
		});
	});
});

describe('describeAgent', () => {
	it('names just the CLI when no model override is set', () => {
		expect(describeAgent('claude')).toBe('claude');
	});

	it('appends the model in parens when one is set', () => {
		expect(describeAgent('claude', 'sonnet')).toBe('claude (sonnet)');
		expect(describeAgent('antigravity', 'Gemini 3.5 Flash (High)')).toBe(
			'antigravity (Gemini 3.5 Flash (High))',
		);
		expect(describeAgent('codex', 'gpt-5.6-sol')).toBe('codex (gpt-5.6-sol)');
	});
});
