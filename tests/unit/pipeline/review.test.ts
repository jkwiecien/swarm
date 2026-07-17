import { beforeEach, describe, expect, it, vi } from 'vitest';

// The verdict file is read via node:fs; presence + contents are controlled per test.
let verdictFileExists: boolean;
let verdictFileContents: string;
vi.mock('node:fs', () => ({
	existsSync: () => verdictFileExists,
	readFileSync: () => verdictFileContents,
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { buildReviewPrompt, REVIEW_VERDICT_FILENAME, runReviewPhase } from '@/pipeline/review.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-review-20';
const HEAD_SHA = 'abc1234def5678abc1234def5678abc1234def56';

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
	// Detached checkout at the PR head SHA — no branch, matching the review flow.
	const handle: WorktreeHandle = {
		taskId: 'review-20',
		path: WORKTREE_PATH,
		branch: HEAD_SHA,
		detached: true,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		prNumber: '99',
		headSha: HEAD_SHA,
		taskId: 'review-20',
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'reviewer-token'),
		// Ledger writers default to a first-verdict reservation so existing tests
		// exercise the common case without a live database (issue #235).
		markReviewVerdictSubmitted: vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 })),
		abandonReviewVerdict: vi.fn(async () => {}),
	};
}

describe('runReviewPhase', () => {
	beforeEach(() => {
		verdictFileExists = true;
		verdictFileContents = 'request-changes\n';
	});

	it('provisions a detached worktree at the head SHA, runs Claude Code as the reviewer, and returns the verdict', async () => {
		const deps = makeDeps();
		const result = await runReviewPhase(deps);

		// Reviewer credentials are the point of the persona split.
		expect(deps.getToken).toHaveBeenCalledWith(deps.project, 'reviewer');

		// Read-only checkout: detached at the reviewed commit, no task branch.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('review-20', {
			detach: true,
			baseBranch: HEAD_SHA,
		});

		// Claude Code runs with the worktree as CWD, the review prompt, and the
		// reviewer token in GH_TOKEN so gh acts as the reviewer persona.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('gh pr diff 99');
		expect(runArgs.env).toEqual({ GH_TOKEN: 'reviewer-token' });

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');

		expect(result.verdict).toBe('request-changes');
		expect(result.agent.exitCode).toBe(0);
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runReviewPhase({ ...deps, timeoutMs: 60_000, signal });
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
		await runReviewPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('fails before provisioning any worktree when the reviewer token is missing', async () => {
		const deps = makeDeps();
		deps.getToken = vi.fn(async () => {
			throw new Error("No GitHub reviewer token configured for project 'swarm'");
		});
		await expect(runReviewPhase(deps)).rejects.toThrow(/No GitHub reviewer token/);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runReviewPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('honours a cli override (e.g. antigravity)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'antigravity' }));
		await runReviewPhase({ ...deps, cli: 'antigravity' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('antigravity');
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runReviewPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runReviewPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent produced no verdict file', async () => {
		verdictFileExists = false;
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${REVIEW_VERDICT_FILENAME}`),
		);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('throws and cleans up when the verdict file is empty', async () => {
		verdictFileContents = '   \n  ';
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(/empty/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('throws and cleans up when the verdict is not one of the known three', async () => {
		verdictFileContents = 'LGTM!\n';
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(/unrecognized verdict 'LGTM!'/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it.each([
		['approve\n', 'approve'],
		['Approve', 'approve'],
		['REQUEST-CHANGES\n', 'request-changes'],
		['comment', 'comment'],
	])('normalizes verdict %j to %j', async (contents, expected) => {
		verdictFileContents = contents;
		const deps = makeDeps();
		const result = await runReviewPhase(deps);
		expect(result.verdict).toBe(expected);
	});

	describe('auto-merge after approval (issue #231)', () => {
		it('enables GitHub auto-merge when the setting is on and the verdict is approve', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps();
			deps.project = createMockProjectConfig({
				pipeline: { respondToReview: { autoMerge: true } },
			});
			const enablePullRequestAutoMerge = vi.fn(async () => ({
				enabled: true,
				message: 'GitHub auto-merge enabled',
			}));

			const result = await runReviewPhase({ ...deps, enablePullRequestAutoMerge });

			expect(enablePullRequestAutoMerge).toHaveBeenCalledWith(deps.project, 99);
			expect(result.autoMergeEnabled).toBe(true);
		});

		it('does not enable auto-merge for a request-changes verdict', async () => {
			verdictFileContents = 'request-changes\n';
			const deps = makeDeps();
			deps.project = createMockProjectConfig({
				pipeline: { respondToReview: { autoMerge: true } },
			});
			const enablePullRequestAutoMerge = vi.fn();

			const result = await runReviewPhase({ ...deps, enablePullRequestAutoMerge });

			expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
			expect(result.autoMergeEnabled).toBeUndefined();
		});

		it('does not enable auto-merge when the setting is disabled', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps(); // default project leaves autoMerge unset
			const enablePullRequestAutoMerge = vi.fn();

			const result = await runReviewPhase({ ...deps, enablePullRequestAutoMerge });

			expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
			expect(result.autoMergeEnabled).toBeUndefined();
		});

		it('never reaches auto-merge when the review run itself fails', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps();
			deps.project = createMockProjectConfig({
				pipeline: { respondToReview: { autoMerge: true } },
			});
			deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
			const enablePullRequestAutoMerge = vi.fn();

			await expect(runReviewPhase({ ...deps, enablePullRequestAutoMerge })).rejects.toThrow(
				/exited with code 1/,
			);
			expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
		});

		it('keeps a completed review successful when arming auto-merge fails', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps();
			deps.project = createMockProjectConfig({
				pipeline: { respondToReview: { autoMerge: true } },
			});
			const enablePullRequestAutoMerge = vi.fn(async () => {
				throw new Error('provider unavailable');
			});

			const result = await runReviewPhase({ ...deps, enablePullRequestAutoMerge });

			expect(result.verdict).toBe('approve');
			expect(result.autoMergeEnabled).toBe(false);
			expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
		});
	});

	describe('two-verdict safety-cap ledger (issue #235)', () => {
		it('marks the reserved head submitted with the verdict, by natural key', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps();
			await runReviewPhase(deps);

			expect(deps.markReviewVerdictSubmitted).toHaveBeenCalledWith(
				{
					projectId: deps.project.id,
					repository: deps.project.repo,
					prNumber: '99',
					headSha: HEAD_SHA,
				},
				{ verdict: 'approve' },
			);
			expect(deps.abandonReviewVerdict).not.toHaveBeenCalled();
		});

		it('surfaces the ledger ordinal on the result', async () => {
			verdictFileContents = 'request-changes\n';
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 }));

			const result = await runReviewPhase(deps);

			expect(result.reviewOrdinal).toBe(1);
			expect(result.automationOutcome).toBeUndefined();
		});

		it('records manual-intervention-required when the second verdict is request-changes', async () => {
			verdictFileContents = 'request-changes\n';
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-2', ordinal: 2 }));

			const result = await runReviewPhase(deps);

			expect(result.reviewOrdinal).toBe(2);
			expect(result.automationOutcome).toBe('manual-intervention-required');
		});

		it('does not record manual-intervention-required for a second-slot approval', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-2', ordinal: 2 }));

			const result = await runReviewPhase(deps);

			expect(result.automationOutcome).toBeUndefined();
		});

		it('abandons the reservation when the agent fails before any review was submitted', async () => {
			const deps = makeDeps();
			deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));

			await expect(runReviewPhase(deps)).rejects.toThrow(/exited with code 1/);

			expect(deps.abandonReviewVerdict).toHaveBeenCalledWith({
				projectId: deps.project.id,
				repository: deps.project.repo,
				prNumber: '99',
				headSha: HEAD_SHA,
			});
			expect(deps.markReviewVerdictSubmitted).not.toHaveBeenCalled();
		});

		it('does not fail the run when abandoning the reservation itself throws', async () => {
			const deps = makeDeps();
			deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
			deps.abandonReviewVerdict = vi.fn(async () => {
				throw new Error('connection reset');
			});

			await expect(runReviewPhase(deps)).rejects.toThrow(/exited with code 1/);
		});
	});
});

describe('buildReviewPrompt', () => {
	const context = { repo: 'jkwiecien/swarm', prNumber: '99', headSha: HEAD_SHA };

	it('instructs reading the PR, the full diff, submitting one formal review, and recording the verdict', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('gh pr view 99 --repo jkwiecien/swarm --comments');
		expect(prompt).toContain('gh pr diff 99 --repo jkwiecien/swarm');
		expect(prompt).toContain('gh pr review 99 --repo jkwiecien/swarm');
		expect(prompt).toContain('--approve');
		expect(prompt).toContain('--request-changes');
		expect(prompt).toContain('--comment');
		expect(prompt).toContain(REVIEW_VERDICT_FILENAME);
		expect(prompt).toContain('Confirm README.md remains accurate for the changes in this PR.');
		expect(prompt).toContain('report the missing README update as a review finding');
	});

	it('pins the review to the head SHA and forbids modifying the repository', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain(HEAD_SHA);
		expect(prompt).toContain('REVIEW ONLY');
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toMatch(/Do NOT `git add`\/commit/);
		expect(prompt).toContain('Do not merge the PR');
	});

	it('carries the GH identity guard so the reviewer persona token is not overridden', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('GH_TOKEN');
		expect(prompt).toContain('gh auth switch');
	});
});
