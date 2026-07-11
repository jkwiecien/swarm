import { beforeEach, describe, expect, it, vi } from 'vitest';

// The plan and split files are read via node:fs; presence + contents are
// controlled per test, keyed on the filename so the two files are independent.
let planExists: boolean;
let planContents: string;
let splitExists: boolean;
let splitContents: string;
function fsFor(path: unknown): { exists: boolean; contents: string } {
	return String(path).endsWith('proposed_split.json')
		? { exists: splitExists, contents: splitContents }
		: { exists: planExists, contents: planContents };
}
vi.mock('node:fs', () => ({
	existsSync: (path: unknown) => fsFor(path).exists,
	readFileSync: (path: unknown) => fsFor(path).contents,
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import {
	buildPlanningPrompt,
	PROPOSED_PLAN_FILENAME,
	PROPOSED_SPLIT_FILENAME,
	planCommentBody,
	runPlanningPhase,
	SPLIT_CHILD_LABEL,
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
		reuse: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	const pm = {
		type: 'github-projects' as const,
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(),
		addComment: vi.fn<(id: string, text: string) => Promise<string>>(async () => 'comment-1'),
		moveWorkItem: vi.fn(async () => {}),
		createWorkItem: vi.fn(async (input) =>
			createMockWorkItem({ id: `PVTI_${input.title}`, title: input.title, url: input.title }),
		),
		updateWorkItem: vi.fn(async () => {}),
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
		// No split by default — most tests exercise the single-task path.
		splitExists = false;
		splitContents = '';
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

	it('splits a large task: spawns siblings in Planning with the split-child label and a comment, and re-scopes the original', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			mainTask: { title: 'First slice', description: 'Just the API' },
			subTasks: [
				{ title: 'Second slice', description: 'The UI' },
				{ title: 'Third slice', description: 'The docs' },
			],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });

		// Original re-scoped/renamed into the smaller first task.
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith('PVTI_item18', {
			title: 'First slice',
			description: 'Just the API',
		});

		// Two siblings created, each in Planning, each carrying the split-child label.
		expect(deps.pm.createWorkItem).toHaveBeenCalledTimes(2);
		for (const call of deps.pm.createWorkItem.mock.calls) {
			expect(call[0]).toMatchObject({ status: 'planning', labels: [SPLIT_CHILD_LABEL] });
		}
		expect(deps.pm.createWorkItem.mock.calls.map((c) => c[0].title)).toEqual([
			'Second slice',
			'Third slice',
		]);

		// Each sibling gets an explanatory comment (plus the original's plan comment).
		const commentTargets = deps.pm.addComment.mock.calls.map((c) => c[0]);
		expect(commentTargets).toContain('PVTI_Second slice');
		expect(commentTargets).toContain('PVTI_Third slice');
		const siblingComment = deps.pm.addComment.mock.calls.find(
			(c) => c[0] === 'PVTI_Second slice',
		)?.[1];
		expect(siblingComment).toMatch(/Split from a larger task/);

		// The first task still auto-advances (autoAdvance on, not a split-child).
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item18', 'todo');
		expect(result.split).toEqual({
			subTaskItemIds: ['PVTI_Second slice', 'PVTI_Third slice'],
			mainTaskUpdated: true,
		});
	});

	it('does not split when autoSplit is off, even if a split file exists', async () => {
		splitExists = true;
		splitContents = JSON.stringify({ subTasks: [{ title: 'X', description: 'Y' }] });
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoSplit: false });
		expect(deps.pm.createWorkItem).not.toHaveBeenCalled();
		expect(deps.pm.updateWorkItem).not.toHaveBeenCalled();
		expect(result.split).toBeUndefined();
	});

	it('never auto-advances a split-child item even when autoAdvance is on', async () => {
		const deps = makeDeps();
		deps.workItem = createMockWorkItem({
			id: 'PVTI_child',
			title: 'A spawned task',
			labels: [{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL }],
		});
		await runPlanningPhase({ ...deps, autoAdvance: true });
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
	});

	it('leaves the original title untouched when the split omits mainTask', async () => {
		splitExists = true;
		splitContents = JSON.stringify({ subTasks: [{ title: 'Only sibling', description: 'Z' }] });
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);
		expect(deps.pm.updateWorkItem).not.toHaveBeenCalled();
		expect(deps.pm.createWorkItem).toHaveBeenCalledTimes(1);
		expect(result.split).toMatchObject({ mainTaskUpdated: false });
	});

	it('treats an empty subTasks array as no split', async () => {
		splitExists = true;
		splitContents = JSON.stringify({ subTasks: [] });
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);
		expect(deps.pm.createWorkItem).not.toHaveBeenCalled();
		expect(result.split).toBeUndefined();
	});

	it('throws on a malformed split file rather than silently skipping the split', async () => {
		splitExists = true;
		splitContents = '{ not valid json';
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
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

	it('threads sessionId (not resumeSessionId) and provisions a fresh detached checkout on a first run', async () => {
		const deps = makeDeps();
		await runPlanningPhase({ ...deps, sessionId: 'sess-18' });

		expect(deps.worktrees.reuse).not.toHaveBeenCalled();
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.sessionId).toBe('sess-18');
		expect(runArgs.resumeSessionId).toBeUndefined();
	});

	it('resumes the Claude session in place: reuses the detached checkout and threads resumeSessionId, not sessionId', async () => {
		const deps = makeDeps();
		await runPlanningPhase({ ...deps, sessionId: 'sess-18', resumeSessionId: 'sess-18' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('18', 'main', true);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBe('sess-18');
		expect(runArgs.sessionId).toBeUndefined();
	});

	it('falls back to a fresh detached provision when the session worktree is gone', async () => {
		const deps = makeDeps();
		vi.mocked(deps.worktrees.reuse).mockResolvedValueOnce(undefined);
		await runPlanningPhase({ ...deps, sessionId: 'sess-18', resumeSessionId: 'sess-18' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('18', 'main', true);
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBeUndefined();
		expect(runArgs.sessionId).toBe('sess-18');
	});

	it('preserves the worktree (skips cleanup) when a claude session run fails on a rate limit', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
			}),
		);
		await expect(runPlanningPhase({ ...deps, sessionId: 'sess-18' })).rejects.toThrow(
			/rate limited/,
		);
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('still cleans up a rate-limited failure that had no session to resume', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
			}),
		);
		await expect(runPlanningPhase(deps)).rejects.toThrow(/rate limited/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});
});

describe('buildPlanningPrompt', () => {
	it('instructs writing the plan to proposed_plan.md and forbids code changes', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem({ title: 'T', description: 'D' }));
		expect(prompt).toContain(PROPOSED_PLAN_FILENAME);
		expect(prompt).toMatch(/PLANNING ONLY/);
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toContain('T');
		expect(prompt).toContain('D');
	});

	it('falls back to a placeholder when the work item has no description', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem({ description: '' }));
		expect(prompt).toContain('(no description provided)');
	});

	it('omits split instructions by default', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem());
		expect(prompt).not.toContain(PROPOSED_SPLIT_FILENAME);
	});

	it('invites splitting when allowSplit is on', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem(), true);
		expect(prompt).toContain(PROPOSED_SPLIT_FILENAME);
		expect(prompt).toMatch(/too large/i);
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
