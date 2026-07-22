import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';

// Both seams are mocked at the module boundary (ai/TESTING.md): the harness, so
// a fake Claude run can emit lines on demand without a subprocess, and the
// repository, so the events this module persists can be asserted without a DB.
const appendRunOutputEvents =
	vi.fn<
		(
			runId: string,
			events: Array<{ stream: string; content: string; emittedAt: Date }>,
		) => Promise<void>
	>();
vi.mock('@/db/repositories/runsRepository.js', () => ({
	appendRunOutputEvents: (runId: string, events: never) => appendRunOutputEvents(runId, events),
	MAX_RUN_OUTPUT_BYTES: 5_000_000,
}));

let runImpl: (options: RunAgentCliOptions) => Promise<AgentCliResult>;
const runAgentCli = vi.fn((options: RunAgentCliOptions) => runImpl(options));
vi.mock('@/harness/agent-cli.js', () => ({
	runAgentCli: (options: RunAgentCliOptions) => runAgentCli(options),
}));

const { createLiveOutputRunner } = await import('@/worker/live-output.js');

function agentResult(): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: 'done',
		stderr: '',
		durationMs: 10,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

const options = (overrides: Partial<RunAgentCliOptions> = {}): RunAgentCliOptions => ({
	cli: 'claude',
	cwd: '/wt',
	...overrides,
});

/** Every line persisted so far, across batches, in order. */
const persisted = (): string[] =>
	appendRunOutputEvents.mock.calls.flatMap(([, events]) => events.map((e) => e.content));

beforeEach(() => {
	vi.useFakeTimers();
	appendRunOutputEvents.mockReset();
	appendRunOutputEvents.mockResolvedValue(undefined);
	runAgentCli.mockClear();
	runImpl = async () => agentResult();
});

afterEach(() => vi.useRealTimers());

describe('createLiveOutputRunner', () => {
	it('runs the harness untouched when there is no run row to persist to', async () => {
		const runner = createLiveOutputRunner(undefined);
		const opts = options();
		await runner(opts);

		expect(runAgentCli).toHaveBeenCalledWith(opts);
		expect(appendRunOutputEvents).not.toHaveBeenCalled();
	});

	it('persists batched output before the run finishes (issue #356)', async () => {
		// The failure this closes: a Claude run worked for 17 minutes and its first
		// persisted event arrived at process exit. Lines must land while it runs.
		let emit: ((line: string) => void) | undefined;
		let finish: ((result: AgentCliResult) => void) | undefined;
		runImpl = (opts) => {
			emit = (line) => opts.onStdout?.(line);
			return new Promise<AgentCliResult>((resolve) => {
				finish = resolve;
			});
		};
		const run = createLiveOutputRunner('run-1')(options({ onStdout: vi.fn() }));
		let settled = false;
		run.then(() => {
			settled = true;
		});

		emit?.('Tool started: Bash');
		emit?.('Tool completed: Bash');
		await vi.advanceTimersByTimeAsync(100);

		expect(persisted()).toEqual(['Tool started: Bash\n', 'Tool completed: Bash\n']);
		expect(settled).toBe(false);

		finish?.(agentResult());
		await run;
		expect(settled).toBe(true);
	});

	it('forwards every line to the caller as well as to the run log', async () => {
		const onStdout = vi.fn();
		const onStderr = vi.fn();
		runImpl = async (opts) => {
			opts.onStdout?.('progress');
			opts.onStderr?.('a warning');
			return agentResult();
		};
		await createLiveOutputRunner('run-1')(options({ onStdout, onStderr }));

		expect(onStdout).toHaveBeenCalledWith('progress');
		expect(onStderr).toHaveBeenCalledWith('a warning');
		expect(appendRunOutputEvents).toHaveBeenCalledWith('run-1', [
			{ stream: 'stdout', content: 'progress\n', emittedAt: expect.any(Date) },
			{ stream: 'stderr', content: 'a warning\n', emittedAt: expect.any(Date) },
		]);
	});

	it('marks a silent Claude run as still alive, and stops once it settles', async () => {
		let finish: ((result: AgentCliResult) => void) | undefined;
		runImpl = () =>
			new Promise<AgentCliResult>((resolve) => {
				finish = resolve;
			});
		const run = createLiveOutputRunner('run-1')(options());

		// A little past each interval, so the heartbeat's own batch window flushes.
		await vi.advanceTimersByTimeAsync(30_100);
		await vi.advanceTimersByTimeAsync(30_100);
		expect(persisted()).toEqual([
			'Still running — no output for 30s.\n',
			'Still running — no output for 30s.\n',
		]);

		finish?.(agentResult());
		await run;
		const afterRun = persisted().length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(persisted()).toHaveLength(afterRun);
	});

	it('postpones the heartbeat whenever the run actually says something', async () => {
		let emit: ((line: string) => void) | undefined;
		let finish: ((result: AgentCliResult) => void) | undefined;
		runImpl = (opts) => {
			emit = (line) => opts.onStdout?.(line);
			return new Promise<AgentCliResult>((resolve) => {
				finish = resolve;
			});
		};
		const run = createLiveOutputRunner('run-1')(options());

		await vi.advanceTimersByTimeAsync(25_000);
		emit?.('Tool started: Bash');
		await vi.advanceTimersByTimeAsync(25_000);
		expect(persisted()).toEqual(['Tool started: Bash\n']);

		await vi.advanceTimersByTimeAsync(5_100);
		expect(persisted()).toEqual(['Tool started: Bash\n', 'Still running — no output for 30s.\n']);

		finish?.(agentResult());
		await run;
	});

	it('leaves the other CLIs without a heartbeat', async () => {
		let finish: ((result: AgentCliResult) => void) | undefined;
		runImpl = () =>
			new Promise<AgentCliResult>((resolve) => {
				finish = resolve;
			});
		const run = createLiveOutputRunner('run-1')(options({ cli: 'codex' }));

		await vi.advanceTimersByTimeAsync(120_000);
		expect(appendRunOutputEvents).not.toHaveBeenCalled();

		finish?.(agentResult());
		await run;
	});

	it('flushes what a failed run managed to say before it threw', async () => {
		runImpl = async (opts) => {
			opts.onStdout?.('Tool started: Bash');
			throw new Error('Failed to launch claude ("claude"): spawn claude ENOENT');
		};

		await expect(createLiveOutputRunner('run-1')(options())).rejects.toThrow(/ENOENT/);
		expect(persisted()).toEqual(['Tool started: Bash\n']);
	});

	it('keeps the run going when persistence fails', async () => {
		appendRunOutputEvents.mockRejectedValue(new Error('db down'));
		runImpl = async (opts) => {
			opts.onStdout?.('progress');
			return agentResult();
		};

		await expect(createLiveOutputRunner('run-1')(options())).resolves.toMatchObject({
			exitCode: 0,
		});
	});

	it('stops appending once the retention budget is spent, keeping the boundary line', async () => {
		const line = 'x'.repeat(100_000);
		runImpl = async (opts) => {
			for (let i = 0; i < 60; i++) opts.onStdout?.(line);
			return agentResult();
		};
		await createLiveOutputRunner('run-1')(options());

		// 5 MB budget / ~100 KB lines: the line that crosses it is kept (the
		// repository clips it and flags retention), everything after is dropped.
		expect(persisted()).toHaveLength(50);
	});
});
