import { beforeEach, describe, expect, it, vi } from 'vitest';

// The plan file is read via node:fs; presence + contents are controlled per test.
let planExists: boolean;
let planContents: string;
vi.mock('node:fs', () => ({
	existsSync: () => planExists,
	readFileSync: () => planContents,
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
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
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 42,
		timedOut: false,
		aborted: false,
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
		addComment: vi.fn<(id: string, text: string) => Promise<string>>(async () => 'comment-1'),
		moveWorkItem: vi.fn(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		workItem: createMockWorkItem({ id: 'PVTI_item18', title: 'Add planning phase' }),
		taskId: '18',
		pm,
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
	};
}

describe('runPlanningPhase', () => {
	beforeEach(() => {
		planExists = true;
		planContents = '# Plan\n\n1. Do the thing.';
	});

	it('provisions a detached worktree, runs the planning agent, posts the plan, and leaves the item in Planning by default (autoAdvance off)', async () => {
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);

		// Read-only checkout: detached, so no task branch is created/held.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });

		// The planning agent is run with the worktree as CWD and the planning
		// prompt. Defaults to Claude Code (see DEFAULT_PLANNING_CLI's comment) —
		// not Antigravity per PROJECT.md §5.1 — until Antigravity's setup path exists.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('Add planning phase');

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// The plan is posted on the linked item; the item itself stays in Planning —
		// `autoAdvance` is unset, which defaults to false, so a human moves it
		// to ToDo themselves after reviewing.
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.addComment.mock.calls[0][0]).toBe('PVTI_item18');
		expect(deps.pm.addComment.mock.calls[0][1]).toContain('Do the thing.');
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');

		expect(result).toMatchObject({
			commentId: 'comment-1',
			plan: '# Plan\n\n1. Do the thing.',
			movedTo: undefined,
		});
	});

	it('moves the item to todo when autoAdvance is on', async () => {
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });

		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item18', 'todo');
		expect(result).toMatchObject({ movedTo: 'todo' });
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runPlanningPhase({ ...deps, timeoutMs: 60_000, signal });
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
		await runPlanningPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runPlanningPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('honours a cli override (e.g. claude)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'claude' }));
		await runPlanningPhase({ ...deps, cli: 'claude' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('claude');
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

	it('does not let a cleanup failure mask a successful run', async () => {
		const deps = makeDeps();
		deps.worktrees.cleanup = vi.fn(async () => {
			throw new Error('rm -rf worktree failed');
		});
		// The agent exited 0 and the plan was posted, so the run succeeded — a
		// cleanup throw is swallowed-and-logged, not re-raised.
		const result = await runPlanningPhase(deps);
		expect(result).toMatchObject({ commentId: 'comment-1' });
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
	it('wraps the plan with a header and, by default, a move-it-yourself hint', () => {
		const body = planCommentBody('step one');
		expect(body).toContain('Proposed implementation plan');
		expect(body).toContain('step one');
		expect(body).toContain('ToDo');
		expect(body).toMatch(/Move this item/);
	});

	it('says the item is moving automatically when autoAdvance is on', () => {
		const body = planCommentBody('step one', true);
		expect(body).toMatch(/moving to \*\*ToDo\*\* automatically/);
	});
});
