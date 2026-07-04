import { beforeEach, describe, expect, it, vi } from 'vitest';

// The PR-URL file is read via node:fs; presence + contents are controlled per test.
let prFileExists: boolean;
let prFileContents: string;
vi.mock('node:fs', () => ({
	existsSync: () => prFileExists,
	readFileSync: () => prFileContents,
}));

import type { AgentCliResult } from '@/harness/agent-cli.js';
import {
	buildImplementationPrompt,
	implementationCommentBody,
	OPENED_PR_FILENAME,
	runImplementationPhase,
} from '@/pipeline/implementation.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-19';

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 42,
		timedOut: false,
		outputTruncated: false,
		...overrides,
	};
}

function makeDeps() {
	const handle: WorktreeHandle = {
		taskId: '19',
		path: WORKTREE_PATH,
		branch: 'issue-19',
		detached: false,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	const pm = {
		type: 'github-projects' as const,
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(),
		addComment: vi.fn(async () => 'comment-1'),
		moveWorkItem: vi.fn(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		workItem: createMockWorkItem({ id: 'PVTI_item19', title: 'Add implementation phase' }),
		taskId: '19',
		pm,
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn(async () => agentResult()),
		graft: vi.fn(() => []),
	};
}

describe('runImplementationPhase', () => {
	beforeEach(() => {
		prFileExists = true;
		prFileContents = 'https://github.com/jkwiecien/swarm/pull/99\n';
	});

	it('provisions the task-branch worktree, runs Claude Code, links the PR, and moves the item to inReview', async () => {
		const deps = makeDeps();
		const result = await runImplementationPhase(deps);

		// Task-branch checkout: provisioned with defaults (createBranch), NOT detached.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19');

		// Claude Code is run with the worktree as CWD and the implementation prompt.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('Add implementation phase');

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// The PR link is posted on the linked item, then the item advances to inReview.
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.addComment.mock.calls[0][0]).toBe('PVTI_item19');
		expect(deps.pm.addComment.mock.calls[0][1]).toContain(
			'https://github.com/jkwiecien/swarm/pull/99',
		);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item19', 'inReview');

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');

		expect(result).toMatchObject({
			prUrl: 'https://github.com/jkwiecien/swarm/pull/99',
			branch: 'issue-19',
			commentId: 'comment-1',
			movedTo: 'inReview',
		});
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runImplementationPhase({ ...deps, timeoutMs: 60_000, signal });
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.timeoutMs).toBe(60_000);
		expect(runArgs.signal).toBe(signal);
		expect(runArgs.maxOutputBytes).toBeGreaterThan(0);
	});

	it('grafts the environment before running the agent', async () => {
		const deps = makeDeps();
		const order: string[] = [];
		deps.graft = vi.fn(() => {
			order.push('graft');
			return [];
		});
		deps.runAgent = vi.fn(async () => {
			order.push('agent');
			return agentResult();
		});
		await runImplementationPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runImplementationPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('honours a cli override (e.g. antigravity)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'antigravity' }));
		await runImplementationPhase({ ...deps, cli: 'antigravity' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('antigravity');
	});

	it('posts and moves in order: comment before the status move', async () => {
		const deps = makeDeps();
		const order: string[] = [];
		deps.pm.addComment.mockImplementation(async () => {
			order.push('comment');
			return 'comment-1';
		});
		deps.pm.moveWorkItem.mockImplementation(async () => {
			order.push('move');
		});
		await runImplementationPhase(deps);
		expect(order).toEqual(['comment', 'move']);
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runImplementationPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runImplementationPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent produced no PR-URL file', async () => {
		prFileExists = false;
		const deps = makeDeps();
		await expect(runImplementationPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${OPENED_PR_FILENAME}`),
		);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('throws and cleans up when the PR-URL file is empty', async () => {
		prFileContents = '   \n  ';
		const deps = makeDeps();
		await expect(runImplementationPhase(deps)).rejects.toThrow(/empty/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('cleans up the worktree even when posting the comment throws', async () => {
		const deps = makeDeps();
		deps.pm.addComment.mockRejectedValue(new Error('GraphQL 502'));
		await expect(runImplementationPhase(deps)).rejects.toThrow(/GraphQL 502/);
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});
});

describe('buildImplementationPrompt', () => {
	const context = {
		repo: 'jkwiecien/swarm',
		taskId: '19',
		branch: 'issue-19',
		baseBranch: 'main',
	};

	it('instructs implementing, committing, pushing, opening a PR that closes the issue, and recording the URL', () => {
		const prompt = buildImplementationPrompt(
			createMockWorkItem({ title: 'T', description: 'D' }),
			context,
		);
		expect(prompt).toContain(OPENED_PR_FILENAME);
		expect(prompt).toContain('Closes #19');
		expect(prompt).toContain('git push -u origin issue-19');
		expect(prompt).toContain('gh pr create');
		expect(prompt).toContain('main');
		expect(prompt).toContain('T');
		expect(prompt).toContain('D');
	});

	it('falls back to a placeholder when the work item has no description', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem({ description: '' }), context);
		expect(prompt).toContain('(no description provided)');
	});
});

describe('implementationCommentBody', () => {
	it('wraps the PR URL with a header and an in-review hint', () => {
		const body = implementationCommentBody('https://github.com/jkwiecien/swarm/pull/99');
		expect(body).toContain('Implementation complete');
		expect(body).toContain('https://github.com/jkwiecien/swarm/pull/99');
		expect(body).toContain('In review');
	});
});
