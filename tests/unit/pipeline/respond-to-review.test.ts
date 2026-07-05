import { beforeEach, describe, expect, it, vi } from 'vitest';

// The outcome file is read via node:fs; presence + contents are controlled per test.
let outcomeFileExists: boolean;
let outcomeFileContents: string;
vi.mock('node:fs', () => ({
	existsSync: () => outcomeFileExists,
	readFileSync: () => outcomeFileContents,
}));

import type { AgentCliResult } from '@/harness/agent-cli.js';
import {
	buildRespondToReviewPrompt,
	RESPOND_OUTCOME_FILENAME,
	runRespondToReviewPhase,
} from '@/pipeline/respond-to-review.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-respond-21';
const PR_BRANCH = 'issue-21';

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
	// The PR's existing task branch — not detached, the agent pushes fixes here.
	const handle: WorktreeHandle = {
		taskId: 'respond-21',
		path: WORKTREE_PATH,
		branch: PR_BRANCH,
		detached: false,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		prNumber: '99',
		prBranch: PR_BRANCH,
		reviewId: '4242',
		taskId: 'respond-21',
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn(async () => agentResult()),
		graft: vi.fn(() => []),
	};
}

describe('runRespondToReviewPhase', () => {
	beforeEach(() => {
		outcomeFileExists = true;
		outcomeFileContents = 'fixed\n';
	});

	it('provisions a worktree on the PR branch, runs Claude Code as the implementer, and returns the outcome', async () => {
		const deps = makeDeps();
		const result = await runRespondToReviewPhase(deps);

		// The existing task branch, not a fresh cut and not detached — the agent
		// commits and pushes to the PR from here.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('respond-21', {
			createBranch: false,
			branch: PR_BRANCH,
		});

		// Claude Code runs with the worktree as CWD and the respond prompt. No
		// GH_TOKEN override: the implementer is the PR's author, which is what the
		// ambient credentials already are (unlike the review phase).
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('reviews/4242');
		expect(runArgs.env).toBeUndefined();

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');

		expect(result.outcome).toBe('fixed');
		expect(result.agent.exitCode).toBe(0);
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runRespondToReviewPhase({ ...deps, timeoutMs: 60_000, signal });
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
		await runRespondToReviewPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('does not clean up when provisioning itself fails (nothing to remove)', async () => {
		const deps = makeDeps();
		deps.worktrees.provision = vi.fn(async () => {
			throw new Error("git worktree add failed: invalid reference: 'issue-21'");
		});
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/invalid reference/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('honours a cli override (e.g. antigravity)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'antigravity' }));
		await runRespondToReviewPhase({ ...deps, cli: 'antigravity' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('antigravity');
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent produced no outcome file', async () => {
		outcomeFileExists = false;
		const deps = makeDeps();
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${RESPOND_OUTCOME_FILENAME}`),
		);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('throws and cleans up when the outcome file is empty', async () => {
		outcomeFileContents = '   \n  ';
		const deps = makeDeps();
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/empty/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('throws and cleans up when the outcome is not one of the known two', async () => {
		outcomeFileContents = 'done!\n';
		const deps = makeDeps();
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/unrecognized outcome 'done!'/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it.each([
		['fixed\n', 'fixed'],
		['Fixed', 'fixed'],
		['PUSHED-BACK\n', 'pushed-back'],
		['pushed-back', 'pushed-back'],
	])('normalizes outcome %j to %j', async (contents, expected) => {
		outcomeFileContents = contents;
		const deps = makeDeps();
		const result = await runRespondToReviewPhase(deps);
		expect(result.outcome).toBe(expected);
	});
});

describe('buildRespondToReviewPrompt', () => {
	const context = {
		repo: 'jkwiecien/swarm',
		prNumber: '99',
		prBranch: PR_BRANCH,
		reviewId: '4242',
	};

	it('instructs syncing the branch, reading the pinned review, replying point by point, and recording the outcome', () => {
		const prompt = buildRespondToReviewPrompt(context);
		expect(prompt).toContain(`git pull --ff-only origin ${PR_BRANCH}`);
		expect(prompt).toContain('gh api repos/jkwiecien/swarm/pulls/99/reviews/4242');
		expect(prompt).toContain('gh api repos/jkwiecien/swarm/pulls/99/reviews/4242/comments');
		expect(prompt).toContain('gh pr view 99 --repo jkwiecien/swarm --comments');
		expect(prompt).toContain('gh pr comment 99 --repo jkwiecien/swarm');
		expect(prompt).toContain(RESPOND_OUTCOME_FILENAME);
	});

	it('offers both paths — fix the code or push back with rationale — and forbids merging or self-review', () => {
		const prompt = buildRespondToReviewPrompt(context);
		expect(prompt).toContain('fix the code');
		expect(prompt).toContain('push back');
		expect(prompt).toContain('`fixed`');
		expect(prompt).toContain('`pushed-back`');
		expect(prompt).toMatch(/Do NOT `git add`\/commit/);
		expect(prompt).toContain('Do not merge the PR');
		expect(prompt).toContain('do not submit a review of your own');
	});
});
