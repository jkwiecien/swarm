import { beforeEach, describe, expect, it, vi } from 'vitest';

// The plan file is read via node:fs; presence + contents are controlled per test.
let planExists: boolean;
let planContents: string;
vi.mock('node:fs', () => ({
	existsSync: () => planExists,
	readFileSync: () => planContents,
}));

import type { AgentCliResult } from '@/harness/agent-cli.js';
import {
	buildPlanningPrompt,
	PROPOSED_PLAN_FILENAME,
	planCommentBody,
	runPlanningPhase,
} from '@/pipeline/planning.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-18';

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'antigravity',
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
		taskId: '18',
		path: WORKTREE_PATH,
		branch: 'main',
		detached: true,
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
		workItem: createMockWorkItem({ id: 'PVTI_item18', title: 'Add planning phase' }),
		taskId: '18',
		pm,
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn(async () => agentResult()),
		graft: vi.fn(() => []),
	};
}

describe('runPlanningPhase', () => {
	beforeEach(() => {
		planExists = true;
		planContents = '# Plan\n\n1. Do the thing.';
	});

	it('provisions a detached worktree, runs Antigravity, posts the plan, and moves the item to todo', async () => {
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);

		// Read-only checkout: detached, so no task branch is created/held.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });

		// Antigravity is run with the worktree as CWD and the planning prompt.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('antigravity');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('Add planning phase');

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// The plan is posted on the linked item, then the item advances to todo.
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.addComment.mock.calls[0][0]).toBe('PVTI_item18');
		expect(deps.pm.addComment.mock.calls[0][1]).toContain('Do the thing.');
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item18', 'todo');

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');

		expect(result).toMatchObject({
			commentId: 'comment-1',
			movedTo: 'todo',
			plan: '# Plan\n\n1. Do the thing.',
		});
	});

	it('honours a cli override (e.g. claude)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'claude' }));
		await runPlanningPhase({ ...deps, cli: 'claude' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('claude');
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
		await runPlanningPhase(deps);
		expect(order).toEqual(['comment', 'move']);
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runPlanningPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runPlanningPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent produced no plan file', async () => {
		planExists = false;
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${PROPOSED_PLAN_FILENAME}`),
		);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('throws and cleans up when the plan file is empty', async () => {
		planContents = '   \n  ';
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow(/empty/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('cleans up the worktree even when posting the comment throws', async () => {
		const deps = makeDeps();
		deps.pm.addComment.mockRejectedValue(new Error('GraphQL 502'));
		await expect(runPlanningPhase(deps)).rejects.toThrow(/GraphQL 502/);
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});
});

describe('buildPlanningPrompt', () => {
	it('instructs writing the plan to proposed_plan.md and forbids code changes', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem({ title: 'T', description: 'D' }));
		expect(prompt).toContain(PROPOSED_PLAN_FILENAME);
		expect(prompt).toMatch(/PLANNING ONLY/);
		expect(prompt).toContain('T');
		expect(prompt).toContain('D');
	});

	it('falls back to a placeholder when the work item has no description', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem({ description: '' }));
		expect(prompt).toContain('(no description provided)');
	});
});

describe('planCommentBody', () => {
	it('wraps the plan with a header and an advance-the-pipeline hint', () => {
		const body = planCommentBody('step one');
		expect(body).toContain('Proposed implementation plan');
		expect(body).toContain('step one');
		expect(body).toContain('In progress');
	});
});
