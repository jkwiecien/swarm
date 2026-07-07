import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the subprocess boundary — unit tests never spawn a real CLI
// (ai/TESTING.md "mock … LLM CLI subprocess calls"). The fake child lets each
// test drive stdout/stderr, close, and error events deterministically.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { type AgentCliResult, runAgentCli } from '@/harness/agent-cli.js';
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
			stdout: 'hello\nworld\n',
			stderr: 'a warning\n',
			timedOut: false,
			outputTruncated: false,
		});

		expect(spawnMock).toHaveBeenCalledWith('claude', ['-p', '--dangerously-skip-permissions'], {
			cwd: '/wt',
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	});

	it('prepends the non-interactive/permission-bypass flags ahead of the caller-supplied prompt for claude', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions({ args: ['implement the thing'] }));
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			['-p', '--dangerously-skip-permissions', 'implement the thing'],
			expect.anything(),
		);
	});

	it('prepends no default flags for antigravity (none researched yet)', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'antigravity', args: ['do the thing'] }),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith('antigravity', ['do the thing'], expect.anything());
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
		expect(args).toEqual(['-p', '--dangerously-skip-permissions', '--print', 'do the thing']);
		expect(opts.env.SWARM_TASK).toBe('42');
		expect(opts.env.PATH).toBe(process.env.PATH);
	});

	it('rejects on an unknown CLI', async () => {
		// @ts-expect-error — exercising runtime validation with an invalid value
		await expect(runAgentCli({ cli: 'codex', cwd: '/wt' })).rejects.toThrow();
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

	it('does not echo output lines to the logger by default, but does when logLines is set', async () => {
		const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
		try {
			const quiet = runAgentCli(createMockRunAgentCliOptions());
			const quietChild = lastChild();
			quietChild.stdout.emit('data', 'quiet line\n');
			quietChild.emit('close', 0, null);
			await quiet;
			expect(debugSpy).not.toHaveBeenCalled();

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
			expect(result.exitCode).toBeNull();
			expect(result.signal).toBe('SIGKILL');
		});

		it('kills when the abort signal fires, without marking it as a timeout', async () => {
			const controller = new AbortController();
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: controller.signal }));
			const child = lastChild();

			controller.abort();
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			child.emit('close', null, 'SIGTERM');
			const result = await promise;
			expect(result.timedOut).toBe(false);
			expect(result.signal).toBe('SIGTERM');
		});

		it('kills immediately when given an already-aborted signal', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: AbortSignal.abort() }));
			const child = lastChild();
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			child.emit('close', null, 'SIGTERM');
			await promise;
		});
	});
});
