/**
 * Implementation phase (PROJECT.md §5.2, ai/ARCHITECTURE.md "Pipeline phases" #2).
 *
 * An item moves to "In progress" on the board → the worker runs this: provision a
 * worktree on the task branch (not detached — unlike Planning, this phase commits
 * and pushes), graft the environment, spin up Claude Code as the implementer to
 * implement the plan / run tests / commit / push / open a PR, then post the PR
 * link back on the item and move it to "In review".
 *
 * Unlike Cascade — whose implementer opens the PR through a `CreatePR` gadget
 * exposed to the agent — SWARM's harness is deliberately narrow (`runAgentCli`
 * only spawns the CLI, no gadget layer; see ai/ARCHITECTURE.md "Harness"). So the
 * agent opens the PR itself via `gh` (the same way the `/solve-issue` skill does)
 * and hands the URL back through a file, mirroring how the Planning phase reads
 * `proposed_plan.md`. The `Closes #<n>` in the PR body is what links the PR back
 * to the Issue the Projects item wraps; the comment this phase posts is the
 * human-facing pointer.
 *
 * This is the phase's orchestration only. It composes the building blocks that
 * already exist — `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15),
 * `runAgentCli` (SWARM-16), the `PMProvider` contract (SWARM-11) — and takes them
 * (plus the work item) as inputs rather than reaching for a queue or a concrete
 * GraphQL provider. The BullMQ consumer that dequeues a `TASK_TYPE_IMPLEMENTATION`
 * job and calls this, and the concrete GitHub Projects `PMProvider` adapter, are
 * their own issues (SWARM-17 and the PM-adapter issue); this lands ahead of them
 * the same way Planning did, wired up when they arrive.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProjectConfig } from '@/config/schema.js';
import { type AgentCli, type AgentCliResult, runAgentCli } from '@/harness/agent-cli.js';
import { logger } from '@/lib/logger.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the implementation agent is instructed to write the opened PR's URL to, at the worktree root. */
export const OPENED_PR_FILENAME = 'opened_pr.txt';

/** Claude Code is SWARM's implementer agent (PROJECT.md §5.2). */
const DEFAULT_IMPLEMENTATION_CLI: AgentCli = 'claude';

/**
 * Status the item moves to once the PR is opened — the board's "In review".
 * Typed to {@link PmStatusKey} so a typo fails to compile rather than silently
 * sending the item to a status the adapter can't resolve. This status isn't a
 * PM-driven phase entry point (`src/pm/pipeline.ts`), so moving here can't loop
 * back into implementation.
 */
const NEXT_STATUS: PmStatusKey = 'inReview';

/**
 * Cap on captured agent output, so a chatty/runaway Claude Code run can't grow the
 * worker's memory without bound. The PR URL is read from {@link OPENED_PR_FILENAME},
 * not from stdout, so truncating the captured stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunImplementationPhaseOptions {
	/** The SWARM project whose board the item lives on. */
	project: ProjectConfig;
	/**
	 * The Projects item that entered "In progress". Its `id` addresses the item
	 * for the PM provider; its `url`/`title`/`description` describe the work.
	 */
	workItem: WorkItem;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`) and branch name
	 * (`<branchPrefix><taskId>`) — the linked issue number. Also the `#<n>` the PR
	 * body closes, which is what links the PR to the item. Passed explicitly rather
	 * than derived from `workItem`: the item's `id` is an opaque node ID, and the
	 * worker that dequeues the job is the layer that knows the issue number.
	 */
	taskId: string;
	/** PM provider used to post the PR-link comment and move the item's status. */
	pm: PMProvider;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Claude Code. */
	cli?: AgentCli;
	/** Kill the agent run after this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the agent run. */
	signal?: AbortSignal;
	/** Injectable agent runner — defaults to {@link runAgentCli}; overridden in tests. */
	runAgent?: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	/** Injectable env-grafting step — defaults to {@link graftEnvironment}; overridden in tests. */
	graft?: typeof graftEnvironment;
}

export interface ImplementationPhaseResult {
	/** The URL of the PR the agent opened, read from {@link OPENED_PR_FILENAME}. */
	prUrl: string;
	/** The branch the implementation was committed to and the PR opened from. */
	branch: string;
	/** ID of the comment the PR link was posted as. */
	commentId: string;
	/** The canonical status the item was moved to. */
	movedTo: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
}

/**
 * Build the prompt handed to the implementation agent. It's told to implement the
 * work item (following the plan the Planning phase posted on the linked Issue),
 * verify with lint/typecheck/tests, commit, push the task branch, open a PR
 * against the base branch whose body closes the issue, and finally record the
 * opened PR's URL to {@link OPENED_PR_FILENAME} so this phase can link it back.
 */
export function buildImplementationPrompt(
	workItem: WorkItem,
	context: { repo: string; taskId: string; branch: string; baseBranch: string },
): string {
	const { repo, taskId, branch, baseBranch } = context;
	return [
		'You are a senior software engineer implementing a work item end to end.',
		'',
		`You are on branch "${branch}", a fresh branch cut from "${baseBranch}" in a git`,
		'worktree whose root is your current working directory. The repository is',
		`${repo} on GitHub.`,
		'',
		'Do all of the following, in order:',
		`1. Read the linked issue and any proposed implementation plan posted on it: run \`gh issue view ${taskId} --repo ${repo} --comments\`.`,
		'2. Explore the repository to learn its conventions, then implement the work item, following the posted plan where one exists.',
		'3. Run the project lint, type-check, and the relevant tests; fix whatever they surface before continuing.',
		`4. Commit your work with a conventional-commit message, then push the branch: \`git push -u origin ${branch}\`.`,
		`5. Open a pull request against "${baseBranch}" with \`gh pr create\`. The PR body MUST contain the line \`Closes #${taskId}\` so the PR links back to the issue.`,
		`6. Write ONLY the resulting PR URL (nothing else) to a file named "${OPENED_PR_FILENAME}" at the root of this worktree.`,
		'',
		'Do not merge the PR — a human does that. Keep the change scoped to the work item.',
		'',
		'--- WORK ITEM ---',
		`Title: ${workItem.title}`,
		`URL: ${workItem.url}`,
		'',
		'Description:',
		workItem.description || '(no description provided)',
	].join('\n');
}

/**
 * Wrap the opened PR URL in a comment body that marks it as SWARM's
 * implementation output and points the human at the PR now awaiting review.
 */
export function implementationCommentBody(prUrl: string): string {
	return [
		'## 🚀 Implementation complete',
		'',
		`A pull request is open and ready for review: ${prUrl.trim()}`,
		'',
		'---',
		'_Generated by SWARM (Implementation phase). This item has moved to **In review**._',
	].join('\n');
}

/**
 * Log a failed implementation run's captured output before the phase throws, so
 * the worker (SWARM-17) that marks the job failed has the agent's own
 * stdout/stderr to diagnose *why* — the thrown Error carries only a message.
 * Output is already bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, workItemId: string, agent: AgentCliResult): void {
	logger.error('implementation phase: agent failed', {
		taskId,
		workItemId,
		cli: agent.cli,
		exitCode: agent.exitCode,
		timedOut: agent.timedOut,
		durationMs: agent.durationMs,
		outputTruncated: agent.outputTruncated,
		stdout: agent.stdout,
		stderr: agent.stderr,
	});
}

/**
 * Run the Implementation phase for one work item. Provisions a worktree on the
 * task branch, runs the implementer agent to build the change and open a PR,
 * posts the PR link as a comment on the linked Issue, and moves the item to
 * "In review".
 *
 * Throws if the agent exits non-zero or produced no PR URL — an implementation
 * run that didn't open a PR is a failed job, not a soft miss
 * (ai/CODING_STANDARDS.md "Error handling"), and the throw lets the worker mark
 * the job failed. The worktree is always removed, success or failure; the pushed
 * branch survives cleanup so the PR is unaffected.
 */
export async function runImplementationPhase(
	options: RunImplementationPhaseOptions,
): Promise<ImplementationPhaseResult> {
	const {
		project,
		workItem,
		taskId,
		pm,
		cli = DEFAULT_IMPLEMENTATION_CLI,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	logger.info('implementation phase: start', { taskId, workItemId: workItem.id, cli });

	// Task-branch checkout (createBranch defaults to true): the agent commits and
	// pushes here, so — unlike Planning — this is not a detached, throwaway HEAD.
	const handle = await worktrees.provision(taskId);
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			cwd: handle.path,
			args: [
				buildImplementationPrompt(workItem, {
					repo: project.repo,
					taskId,
					branch: handle.branch,
					baseBranch: project.baseBranch,
				}),
			],
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, workItem.id, agent);
			throw new Error(
				`Implementation agent (${cli}) exited with code ${agent.exitCode}${
					agent.timedOut ? ' (timed out)' : ''
				} for task '${taskId}'`,
			);
		}

		const prUrlPath = join(handle.path, OPENED_PR_FILENAME);
		if (!existsSync(prUrlPath)) {
			logAgentFailure(taskId, workItem.id, agent);
			throw new Error(
				`Implementation agent (${cli}) did not write ${OPENED_PR_FILENAME} for task '${taskId}'`,
			);
		}
		const prUrl = readFileSync(prUrlPath, 'utf8').trim();
		if (prUrl.length === 0) {
			logAgentFailure(taskId, workItem.id, agent);
			throw new Error(
				`Implementation agent (${cli}) wrote an empty ${OPENED_PR_FILENAME} for task '${taskId}'`,
			);
		}

		const commentId = await pm.addComment(workItem.id, implementationCommentBody(prUrl));
		await pm.moveWorkItem(workItem.id, NEXT_STATUS);

		logger.info('implementation phase: done', {
			taskId,
			workItemId: workItem.id,
			branch: handle.branch,
			prUrl,
			commentId,
			movedTo: NEXT_STATUS,
		});

		return { prUrl, branch: handle.branch, commentId, movedTo: NEXT_STATUS, agent };
	} finally {
		await worktrees.cleanup(taskId);
	}
}
