import { describe, expect, it, vi } from 'vitest';

import type { DelegationContract } from '@/delegation/native.js';
import {
	buildChildLaunch,
	buildChildPrompt,
	type ChildRunResult,
	runDelegatedChild,
	validateContractPaths,
} from '@/delegation/orchestrator.js';

const contract: DelegationContract = {
	version: 1,
	id: 'docs-update',
	delegationType: 'documentation-edit',
	agent: 'swarm-doc-editor',
	task: 'Update the documentation from the decided facts across the listed files.',
	decidedFacts: ['The child model is per-CLI.', 'Codex uses the workspace-write sandbox.'],
	allowedPaths: ['docs/OPTIMIZATION.md', 'README.md'],
	prohibitedScope: ['No source changes.'],
	expectedArtifact: 'Two documentation sections updated consistently.',
	verification: { command: 'npm run lint', evidence: 'exit code 0' },
	reviewRequired: true,
	estimatedSemanticOperations: 4,
};

/** A child runner that reports the given result and records the launch it saw. */
function fakeChild(result: Partial<ChildRunResult> = {}) {
	const launches: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
	const runChild = vi.fn(async (launch) => {
		launches.push(launch);
		return {
			exitCode: 0,
			stdout: '{"result":"done","usage":{"input_tokens":40,"output_tokens":12}}',
			stderr: '',
			durationMs: 5,
			...result,
		} satisfies ChildRunResult;
	});
	return { runChild, launches };
}

/** A snapshot stub that returns `before` then `after` on successive calls. */
function snapshots(before: Record<string, string | null>, after: Record<string, string | null>) {
	const maps: Array<Map<string, string | null>> = [
		new Map(Object.entries(before)),
		new Map(Object.entries(after)),
	];
	return vi.fn(async () => maps.shift() ?? new Map<string, string | null>());
}

describe('buildChildLaunch', () => {
	it('pins the model, restricts Claude to Read/Edit, and sets the recursion guard', () => {
		const launch = buildChildLaunch('claude', 'haiku', '/wt', contract);
		expect(launch.command).toBe('claude');
		expect(launch.args).toContain('--allowedTools');
		expect(launch.args).toContain('Read');
		expect(launch.args).toContain('Edit');
		// The child must NOT bypass permissions (that would re-enable Bash and defeat
		// the allowlist); it uses acceptEdits, which auto-approves edits within the
		// allowlist without granting anything else — so no shell → no git/commit.
		expect(launch.args).not.toContain('--dangerously-skip-permissions');
		expect(launch.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
		expect(launch.args).not.toContain('Bash');
		// `--model` must terminate the variadic --allowedTools list before the prompt.
		expect(launch.args.indexOf('--model')).toBeGreaterThan(launch.args.indexOf('Edit'));
		expect(launch.args).toEqual(expect.arrayContaining(['--model', 'haiku']));
		expect(launch.args[launch.args.length - 1]).toContain('curated SWARM documentation editor');
		expect(launch.env.SWARM_DELEGATION_DEPTH).toBe('1');
	});

	it('runs Codex under the workspace-write sandbox rooted at the worktree', () => {
		const launch = buildChildLaunch('codex', 'gpt-5.4-mini', '/wt', contract);
		expect(launch.command).toBe('codex');
		expect(launch.args.slice(0, 2)).toEqual(['exec', '--model']);
		expect(launch.args).toEqual(
			expect.arrayContaining(['--sandbox', 'workspace-write', '-C', '/wt']),
		);
		// Not the harness default that bypasses the sandbox.
		expect(launch.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(launch.env.SWARM_DELEGATION_DEPTH).toBe('1');
	});
});

describe('validateContractPaths', () => {
	it('accepts documentation files', () => {
		expect(() => validateContractPaths(contract)).not.toThrow();
	});
	it('rejects non-documentation, protected, and escaping paths', () => {
		expect(() => validateContractPaths({ ...contract, allowedPaths: ['src/index.ts'] })).toThrow(
			/not a documentation file/,
		);
		expect(() => validateContractPaths({ ...contract, allowedPaths: ['.git/config'] })).toThrow(
			/not a documentation file/,
		);
		expect(() =>
			validateContractPaths({ ...contract, allowedPaths: ['.claude/agents/x.md'] }),
		).toThrow(/protected area/);
		expect(() => validateContractPaths({ ...contract, allowedPaths: ['../secrets.md'] })).toThrow(
			/escapes the worktree/,
		);
	});
});

describe('runDelegatedChild', () => {
	const baseParams = {
		contract,
		cwd: '/wt',
		phase: 'implementation',
		minimumSemanticOperations: 3,
		parentRunId: 'run-1',
	};

	it('rejects a below-minimum contract without launching a child', async () => {
		const { runChild } = fakeChild();
		const outcome = await runDelegatedChild({
			...baseParams,
			cli: 'codex',
			model: 'gpt-5.4-mini',
			minimumSemanticOperations: 10,
			runChild,
			git: vi.fn(async () => ''),
			snapshot: snapshots({}, {}),
		});
		expect(runChild).not.toHaveBeenCalled();
		expect(outcome.observation.outcome).toBe('rejected');
		expect(outcome.exitCode).toBe(2);
	});

	it('completes an in-scope edit and attributes the child usage to the parent run', async () => {
		const { runChild } = fakeChild();
		const git = vi.fn(async (args: string[]) => (args[0] === 'diff' ? 'diff --git ...' : ''));
		const outcome = await runDelegatedChild({
			...baseParams,
			cli: 'claude',
			model: 'haiku',
			runChild,
			git,
			snapshot: snapshots({}, { 'README.md': 'hash-after' }),
		});
		expect(runChild).toHaveBeenCalledOnce();
		expect(outcome.observation).toMatchObject({
			outcome: 'completed',
			parentRunId: 'run-1',
			phase: 'implementation',
			model: 'haiku',
			usage: { inputTokens: 40, outputTokens: 12 },
		});
		expect(outcome.report).toContain('README.md');
		expect(outcome.exitCode).toBe(0);
	});

	it('rejects and resets an out-of-scope file that was clean before the child (via HEAD)', async () => {
		const { runChild } = fakeChild();
		const git = vi.fn(async () => '');
		const restoreFile = vi.fn();
		const outcome = await runDelegatedChild({
			...baseParams,
			cli: 'codex',
			model: 'gpt-5.4-mini',
			runChild,
			git,
			restoreFile,
			// src/secret.ts was NOT changed before the child (absent from `before`).
			snapshot: snapshots({}, { 'src/secret.ts': 'child-content' }),
		});
		expect(outcome.observation.outcome).toBe('rejected');
		expect(outcome.exitCode).toBe(2);
		// A clean-before path is reset to HEAD, not restored from a snapshot.
		expect(git).toHaveBeenCalledWith(['checkout', 'HEAD', '--', 'src/secret.ts'], '/wt');
		expect(restoreFile).not.toHaveBeenCalled();
	});

	it('restores the primary’s own pre-edit content when the child overwrites an out-of-scope file', async () => {
		const { runChild } = fakeChild();
		const git = vi.fn(async () => '');
		const restoreFile = vi.fn();
		const outcome = await runDelegatedChild({
			...baseParams,
			cli: 'claude',
			model: 'haiku',
			runChild,
			git,
			restoreFile,
			// The primary had already edited src/secret.ts (in `before`); the child
			// overwrote it. Revert must restore the primary's content, never HEAD.
			snapshot: snapshots(
				{ 'src/secret.ts': 'PRIMARY EDIT' },
				{ 'src/secret.ts': 'child clobber' },
			),
		});
		expect(outcome.observation.outcome).toBe('rejected');
		expect(restoreFile).toHaveBeenCalledWith('/wt', 'src/secret.ts', 'PRIMARY EDIT');
		// Must NOT reset the primary's file to HEAD.
		expect(git).not.toHaveBeenCalledWith(['checkout', 'HEAD', '--', 'src/secret.ts'], '/wt');
	});

	it('records a failed outcome when the child exits non-zero', async () => {
		const { runChild } = fakeChild({ exitCode: 1, stdout: '', stderr: 'boom' });
		const outcome = await runDelegatedChild({
			...baseParams,
			cli: 'claude',
			model: 'haiku',
			runChild,
			git: vi.fn(async () => ''),
			snapshot: snapshots({}, {}),
		});
		expect(outcome.observation.outcome).toBe('failed');
		expect(outcome.exitCode).toBe(2);
		expect(outcome.report).toContain('boom');
	});
});

describe('buildChildPrompt', () => {
	it('embeds the decided facts, allowed files, and a no-command instruction', () => {
		const prompt = buildChildPrompt(contract);
		expect(prompt).toContain('The child model is per-CLI.');
		expect(prompt).toContain('docs/OPTIMIZATION.md, README.md');
		expect(prompt).toContain('Do not commit, push');
	});
});
