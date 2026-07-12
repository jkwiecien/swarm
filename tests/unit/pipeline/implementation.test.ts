import { beforeEach, describe, expect, it, vi } from 'vitest';

// The PR-URL file is read via node:fs; presence + contents are controlled per test.
let prFileExists: boolean;
let prFileContents: string;
let blockedReasonFileExists: boolean;
let blockedReasonFileContents: string;
vi.mock('node:fs', () => ({
	existsSync: (path: unknown) =>
		String(path).endsWith('blocked_reason.md') ? blockedReasonFileExists : prFileExists,
	readFileSync: (path: unknown) =>
		String(path).endsWith('blocked_reason.md') ? blockedReasonFileContents : prFileContents,
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import {
	BLOCKED_REASON_FILENAME,
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
		aborted: false,
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
		reuse: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	const pm = {
		type: 'github-projects' as const,
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(),
		addComment: vi.fn<(id: string, text: string) => Promise<string>>(async () => 'comment-1'),
		moveWorkItem: vi.fn(async () => {}),
		createWorkItem: vi.fn(async () => createMockWorkItem({ id: 'PVTI_sibling' })),
		updateWorkItem: vi.fn(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		workItem: createMockWorkItem({ id: 'PVTI_item19', title: 'Add implementation phase' }),
		taskId: '19',
		pm,
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'implementer-token'),
	};
}

describe('runImplementationPhase', () => {
	beforeEach(() => {
		prFileExists = true;
		prFileContents = 'https://github.com/jkwiecien/swarm/pull/99\n';
		blockedReasonFileExists = false;
		blockedReasonFileContents = '';
	});

	it('provisions the task-branch worktree, runs Claude Code, links the PR, and moves the item to inReview by default (autoAdvance on)', async () => {
		const deps = makeDeps();
		const result = await runImplementationPhase(deps);

		// Implementer credentials are the point of the persona split.
		expect(deps.getToken).toHaveBeenCalledWith(deps.project, 'implementer');

		// Reports pickup by moving to In progress before doing any other work.
		expect(deps.pm.moveWorkItem).toHaveBeenNthCalledWith(1, 'PVTI_item19', 'inProgress');

		// Task-branch checkout: provisioned with defaults (createBranch), NOT detached.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19');

		// Claude Code is run with the worktree as CWD, the implementation prompt,
		// and the implementer token in GH_TOKEN so gh (incl. `gh pr create`) acts
		// as the implementer persona, not the worker host's own gh auth login.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('Add implementation phase');
		expect(runArgs.env).toEqual({ GH_TOKEN: 'implementer-token' });

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// The PR link is posted on the linked item, then the item advances to inReview.
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.addComment.mock.calls[0][0]).toBe('PVTI_item19');
		expect(deps.pm.addComment.mock.calls[0][1]).toContain(
			'https://github.com/jkwiecien/swarm/pull/99',
		);
		expect(deps.pm.moveWorkItem).toHaveBeenNthCalledWith(2, 'PVTI_item19', 'inReview');
		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(2);

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');

		expect(result).toMatchObject({
			prUrl: 'https://github.com/jkwiecien/swarm/pull/99',
			branch: 'issue-19',
			commentId: 'comment-1',
			movedTo: 'inReview',
		});
	});

	it('still reports the pickup move but skips the final move when autoAdvance is off', async () => {
		const deps = makeDeps();
		const result = await runImplementationPhase({ ...deps, autoAdvance: false });

		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item19', 'inProgress');
		expect(result).toMatchObject({ movedTo: undefined });
	});

	it('reuses the existing task branch when resuming a deferred implementation', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, resumeExistingBranch: true });

		expect(deps.worktrees.provision).toHaveBeenCalledWith('19', {
			createBranch: false,
			branch: 'issue-19',
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

	it('fails before provisioning any worktree when the implementer token is missing', async () => {
		const deps = makeDeps();
		deps.getToken = vi.fn(async () => {
			throw new Error("No GitHub implementer token configured for project 'swarm'");
		});
		await expect(runImplementationPhase(deps)).rejects.toThrow(/No GitHub implementer token/);
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
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

	it('posts and moves in order: pickup move, then comment, then the final status move', async () => {
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
		expect(order).toEqual(['move', 'comment', 'move']);
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runImplementationPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		// The pickup move already happened before the agent ran; only the final
		// (In review) move never fires.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item19', 'inProgress');
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

	it('surfaces an agent-written blocker instead of a generic missing-PR error', async () => {
		prFileExists = false;
		blockedReasonFileExists = true;
		blockedReasonFileContents = 'Wait for PR #147 to merge, then retry this task.';
		const deps = makeDeps();

		await expect(runImplementationPhase(deps)).rejects.toThrow(
			"Implementation blocked for task '19': Wait for PR #147 to merge, then retry this task.",
		);
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
		// The pickup move already happened; only the final (In review) move never fires.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item19', 'inProgress');
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('threads sessionId (not resumeSessionId) and provisions fresh on a first run', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, sessionId: 'sess-19' });

		expect(deps.worktrees.reuse).not.toHaveBeenCalled();
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19');
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.sessionId).toBe('sess-19');
		expect(runArgs.resumeSessionId).toBeUndefined();
	});

	it('resumes the Claude session in place: reuses the worktree and threads resumeSessionId, not sessionId', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, sessionId: 'sess-19', resumeSessionId: 'sess-19' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('19', 'issue-19', false);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBe('sess-19');
		expect(runArgs.sessionId).toBeUndefined();
	});

	it('falls back to a fresh provision when the session worktree is gone', async () => {
		const deps = makeDeps();
		vi.mocked(deps.worktrees.reuse).mockResolvedValueOnce(undefined);
		await runImplementationPhase({ ...deps, sessionId: 'sess-19', resumeSessionId: 'sess-19' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('19', 'issue-19', false);
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19');
		// Nothing to resume: the fresh checkout gets the first-run sessionId instead.
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBeUndefined();
		expect(runArgs.sessionId).toBe('sess-19');
	});

	it('preserves the worktree (skips cleanup) when a claude session run fails on a rate limit', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
			}),
		);
		await expect(runImplementationPhase({ ...deps, sessionId: 'sess-19' })).rejects.toThrow(
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
		await expect(runImplementationPhase(deps)).rejects.toThrow(/rate limited/);
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
		expect(prompt).toContain(BLOCKED_REASON_FILENAME);
		expect(prompt).toContain('Closes #19');
		expect(prompt).toContain('git push -u origin issue-19');
		expect(prompt).toContain('gh pr create');
		expect(prompt).toContain('main');
		expect(prompt).toContain('T');
		expect(prompt).toContain('D');
	});

	it('tells the agent to read the linked issue and its posted plan first', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('gh issue view 19');
	});

	it('specifies non-interactive gh pr create flags and keeps the PR-URL file uncommitted', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('--base main');
		expect(prompt).toContain('--head issue-19');
		expect(prompt).toMatch(/Do NOT `git add`\/commit/);
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toContain('After step 7, STOP immediately and exit');
		expect(prompt).toContain('Do not wait for a review');
	});

	it('defines a focused completion bar instead of demanding speculative coverage', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('Definition of enough');
		expect(prompt).toContain('smallest durable change');
		expect(prompt).toContain('Do not add speculative features, broad refactors');
		expect(prompt).toContain('focused tests for changed stable behavior');
	});

	it('falls back to a placeholder when the work item has no description', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem({ description: '' }), context);
		expect(prompt).toContain('(no description provided)');
	});

	it('carries the GH identity guard so the implementer persona token is not overridden', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('GH_TOKEN');
		expect(prompt).toContain('gh auth switch');
	});
});

describe('implementationCommentBody', () => {
	it('wraps the PR URL with a header and, by default, an already-moved note', () => {
		const body = implementationCommentBody('https://github.com/jkwiecien/swarm/pull/99');
		expect(body).toContain('Implementation complete');
		expect(body).toContain('https://github.com/jkwiecien/swarm/pull/99');
		expect(body).toContain('In review');
		expect(body).toMatch(/has moved to/);
	});

	it('says to move it yourself when autoAdvance is off', () => {
		const body = implementationCommentBody('https://github.com/jkwiecien/swarm/pull/99', false);
		expect(body).toMatch(/Move this item.*yourself/);
	});
});
