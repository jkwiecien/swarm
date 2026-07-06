/**
 * Planning phase (PROJECT.md §5.1, ai/ARCHITECTURE.md "Pipeline phases" #1).
 *
 * An item moves to "Planning" on the board → the worker runs this: provision a
 * read-only worktree, spin up Antigravity to explore the code graph and write a
 * step-by-step `proposed_plan.md`, post that plan as a comment on the linked
 * Issue (GitHub Projects items have no long-form body of their own), and move the
 * item forward to "ToDo" (PROJECT.md's "Ready for Dev"). The plan is a review
 * artefact, not code — it's delivered as a comment and the worktree is thrown
 * away, so the checkout is detached and never commits.
 *
 * This is the phase's orchestration only. It composes the building blocks that
 * already exist — `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15),
 * `runAgentCli` (SWARM-16), the `PMProvider` contract (SWARM-11) — and takes them
 * (plus the work item) as inputs rather than reaching for a queue or a concrete
 * GraphQL provider. The BullMQ consumer that dequeues a `TASK_TYPE_PLANNING` job
 * and calls this, and the concrete GitHub Projects `PMProvider` adapter, are
 * their own issues (SWARM-17/35 and the PM-adapter issue); this lands ahead of
 * them the same way the router's enqueue seam did, wired up when they arrive.
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

/** The file the planning agent is instructed to write its plan to, at the worktree root. */
export const PROPOSED_PLAN_FILENAME = 'proposed_plan.md';

/** Antigravity is SWARM's planning agent (PROJECT.md §5.1). */
const DEFAULT_PLANNING_CLI: AgentCli = 'antigravity';

/**
 * Status the item moves to once the plan is posted — the board's "ToDo", which is
 * PROJECT.md §5.1's "Ready for Dev". Typed to {@link PmStatusKey} so a typo fails
 * to compile rather than silently sending the item to a status the adapter can't
 * resolve. This status doesn't itself start a phase (`src/pm/pipeline.ts`), so
 * moving here can't loop back into planning.
 */
const NEXT_STATUS: PmStatusKey = 'todo';

/**
 * Cap on captured agent output, so a chatty/runaway Antigravity run can't grow the
 * worker's memory without bound. The plan itself is read from `proposed_plan.md`,
 * not from stdout, so truncating the captured stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunPlanningPhaseOptions {
	/** The SWARM project whose board the item lives on. */
	project: ProjectConfig;
	/**
	 * The Projects item that entered "Planning". Its `id` addresses the item for
	 * the PM provider; its `url`/`title`/`description` describe the work to plan.
	 */
	workItem: WorkItem;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`) — usually the linked
	 * issue number. Passed explicitly rather than derived from `workItem` here: the
	 * item's `id` is an opaque node ID, and the worker that dequeues the job is the
	 * layer that knows the issue number, so it owns that mapping.
	 */
	taskId: string;
	/** PM provider used to post the plan comment and move the item's status. */
	pm: PMProvider;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Antigravity. */
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

export interface PlanningPhaseResult {
	/** The plan text read from `proposed_plan.md`. */
	plan: string;
	/** ID of the comment the plan was posted as. */
	commentId: string;
	/** The canonical status the item was moved to. */
	movedTo: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
}

/**
 * Build the prompt handed to the planning agent. It's told to explore the repo
 * and write a step-by-step implementation plan to `proposed_plan.md` — and, since
 * this is a read-only phase, explicitly *not* to modify code or implement
 * anything (mirroring Cascade's planning agent, which is read/write-to-PM only).
 */
export function buildPlanningPrompt(workItem: WorkItem): string {
	return [
		'You are a senior software architect creating a detailed implementation plan.',
		'',
		'PLANNING ONLY. Do NOT implement, edit, or create any source files, and do NOT',
		'run any command that changes the repository. Your sole deliverable is a plan.',
		'',
		'Explore this repository to understand its existing patterns and conventions,',
		'then write a concrete, step-by-step implementation plan for the work item below.',
		'The plan must cover: the files to add/change, the approach, the testing strategy,',
		'and anything intentionally left out of scope.',
		'',
		`Write the plan — and nothing else — to a file named "${PROPOSED_PLAN_FILENAME}"`,
		'at the root of this worktree, as GitHub-flavored Markdown.',
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
 * Wrap the raw plan in a comment body that marks it as SWARM's proposed plan and
 * tells the human how to advance the pipeline (moving the item to "In progress"
 * is what triggers the implementation phase).
 */
export function planCommentBody(plan: string): string {
	return [
		'## 🗺️ Proposed implementation plan',
		'',
		plan.trim(),
		'',
		'---',
		'_Generated by SWARM (Planning phase). Move this item to **In progress** to begin implementation._',
	].join('\n');
}

/**
 * Log a failed planning run's captured output before the phase throws, so the
 * worker (SWARM-17) that marks the job failed has the agent's own stdout/stderr
 * to diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}, so this can't blow up the log.
 */
function logAgentFailure(taskId: string, workItemId: string, agent: AgentCliResult): void {
	logger.error('planning phase: agent failed', {
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
 * Run the Planning phase for one work item. Provisions a detached worktree, runs
 * the planning agent to produce `proposed_plan.md`, posts it as a comment on the
 * linked Issue, and moves the item to "ToDo".
 *
 * Throws if the agent exits non-zero or produces no plan — a planning run that
 * didn't yield a plan is a failed job, not a soft miss (ai/CODING_STANDARDS.md
 * "Error handling"), and the throw lets the worker mark the job failed. The
 * worktree is always removed, success or failure.
 */
export async function runPlanningPhase(
	options: RunPlanningPhaseOptions,
): Promise<PlanningPhaseResult> {
	const {
		project,
		workItem,
		taskId,
		pm,
		cli = DEFAULT_PLANNING_CLI,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	logger.info('planning phase: start', { taskId, workItemId: workItem.id, cli });

	// Read-only checkout: detached HEAD, no task branch (see ProvisionOptions.detach).
	const handle = await worktrees.provision(taskId, { detach: true });
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			cwd: handle.path,
			args: [buildPlanningPrompt(workItem)],
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, workItem.id, agent);
			throw new Error(
				`Planning agent (${cli}) exited with code ${agent.exitCode}${
					agent.timedOut ? ' (timed out)' : ''
				} for task '${taskId}'`,
			);
		}

		const planPath = join(handle.path, PROPOSED_PLAN_FILENAME);
		if (!existsSync(planPath)) {
			logAgentFailure(taskId, workItem.id, agent);
			throw new Error(
				`Planning agent (${cli}) did not write ${PROPOSED_PLAN_FILENAME} for task '${taskId}'`,
			);
		}
		const plan = readFileSync(planPath, 'utf8').trim();
		if (plan.length === 0) {
			logAgentFailure(taskId, workItem.id, agent);
			throw new Error(
				`Planning agent (${cli}) wrote an empty ${PROPOSED_PLAN_FILENAME} for task '${taskId}'`,
			);
		}

		const commentId = await pm.addComment(workItem.id, planCommentBody(plan));
		await pm.moveWorkItem(workItem.id, NEXT_STATUS);

		logger.info('planning phase: done', {
			taskId,
			workItemId: workItem.id,
			commentId,
			movedTo: NEXT_STATUS,
		});

		return { plan, commentId, movedTo: NEXT_STATUS, agent };
	} finally {
		// Swallow-and-log: a cleanup failure must not mask the run's outcome
		// (a successful phase turning into a reported failure, or a genuine
		// error being replaced by the cleanup error).
		try {
			await worktrees.cleanup(taskId);
		} catch (error) {
			logger.error('planning phase: worktree cleanup failed', {
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
