/**
 * Planning phase (PROJECT.md §5.1, ai/ARCHITECTURE.md "Pipeline phases" #1).
 *
 * An item moves to "Planning" on the board → the worker runs this: provision a
 * read-only worktree, spin up the planning agent (Antigravity per §5.1, though
 * `DEFAULT_PLANNING_CLI` below currently runs Claude Code instead — see that
 * constant's comment) to explore the code graph and write a step-by-step
 * `proposed_plan.md`, and post that plan as a comment on the linked Issue
 * (GitHub Projects items have no long-form body of their own). Whether the
 * item then moves itself to "ToDo" is a per-project setting
 * (`project.pipeline.planning.autoAdvance`, `src/config/schema.ts`) —
 * defaulting to `false`: a human reviews the plan, then moves the item
 * themselves to greenlight Implementation. The plan is a review artefact, not
 * code — it's delivered as a comment and the worktree is thrown away, so the
 * checkout is detached and never commits.
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

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import type { ProjectConfig } from '@/config/schema.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { agentRunError } from '@/harness/agent-failure.js';
import type { ReasoningLevel } from '@/harness/models.js';
import { logger } from '@/lib/logger.js';
import {
	buildPreplanContract,
	embedPreplanMarker,
	evaluatePreplan,
	isPreplanSkip,
} from '@/pipeline/preplan.js';
import {
	buildPlanningPrompt,
	PROPOSED_PLAN_FILENAME,
	PROPOSED_SPLIT_FILENAME,
} from '@/pipeline/prompts/planning.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import { GitWorktreeManager, type WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

// The static planning prompt and the hand-off filenames it names now live in
// `src/pipeline/prompts/planning.ts` (issue #135); re-exported here so existing
// importers of `@/pipeline/planning.js` keep resolving them unchanged.
export { buildPlanningPrompt, PROPOSED_PLAN_FILENAME, PROPOSED_SPLIT_FILENAME };

/**
 * Label applied to every sibling item Planning spawns when it splits a task.
 * Two jobs: it's a visible marker on the board that an item came from a split,
 * and it's the signal {@link runPlanningPhase} reads to force `autoAdvance` off
 * for that item's own Planning run — a split-off task must never move itself to
 * "ToDo", no matter how the workflow is configured (the human sequences them).
 */
export const SPLIT_CHILD_LABEL = 'swarm:split-child';

/** The re-scope/rename patch for the original item (the smaller first task). */
const MainTaskSchema = z.object({
	title: z.string().trim().min(1),
	description: z.string(),
});

/**
 * One sibling a split produces. Unlike the main task, each sibling carries its
 * own concise `plan` — written by the parent Planning run while its repository
 * context is live, so the sibling's own Planning run can reuse it instead of
 * launching a fresh agent (docs/OPTIMIZATION.md §3, issue #178). The plan is a
 * self-contained Markdown brief (scope + acceptance criteria, exclusions,
 * relevant files/symbols, dependencies on preceding siblings, an ordered
 * outline, and verification guidance — see {@link buildPlanningPrompt}).
 */
const SplitSubTaskSchema = z.object({
	title: z.string().trim().min(1),
	description: z.string(),
	plan: z.string().trim().min(1),
});

/**
 * Shape of {@link PROPOSED_SPLIT_FILENAME}. `mainTask` optionally re-scopes/renames
 * the original item into the smaller first task; `subTasks` are the siblings to
 * spawn (each carrying its own reusable plan). Zod is the source of truth for the
 * on-disk contract (ai/CODING_STANDARDS.md "Zod as source of truth").
 */
const ProposedSplitSchema = z.object({
	mainTask: MainTaskSchema.optional(),
	subTasks: z.array(SplitSubTaskSchema).default([]),
});

export type ProposedSplit = z.infer<typeof ProposedSplitSchema>;

/**
 * PROJECT.md §5.1 designs Antigravity as SWARM's planning agent, splitting the
 * planning and implementation roles across two different CLIs. Defaulting to
 * it here breaks Planning on any host that doesn't have `antigravity`
 * installed and authenticated — confirmed against a live run: `spawn
 * antigravity ENOENT`. Until Antigravity's setup path exists, Claude Code
 * covers Planning too (`RunPlanningPhaseOptions.cli` still overrides this per
 * call, for a project that does have Antigravity set up).
 */
export const DEFAULT_PLANNING_CLI: AgentCli = 'claude';

/**
 * Status the item moves to when `autoAdvance` is on — the board's "ToDo",
 * which is PROJECT.md §5.1's "Ready for Dev". Typed to {@link PmStatusKey} so
 * a typo fails to compile rather than silently sending the item to a status
 * the adapter can't resolve.
 */
const NEXT_STATUS: PmStatusKey = 'todo';

/** `autoAdvance` default when `project.pipeline.planning.autoAdvance` is unset. */
const DEFAULT_AUTO_ADVANCE = false;

/**
 * `autoSplit` default when `project.pipeline.planning.autoSplit` is unset. On by
 * default: evaluating task size and splitting a too-large item is the phase's
 * new baseline behavior (a task that fits one PR is never split, so this is
 * inert for right-sized work).
 */
const DEFAULT_AUTO_SPLIT = true;

/**
 * Status a spawned sibling starts in: "Planning", so the existing
 * `pm-status-changed` trigger plans it on its own (the same persona-move →
 * webhook path Planning's own `autoAdvance` → Implementation already relies on).
 */
const SIBLING_START_STATUS: PmStatusKey = 'planning';

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
	/** PM provider used to post the plan comment and, if `autoAdvance`, move the item. */
	pm: PMProvider;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Antigravity. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/** Reasoning level for the agent's session. Omit for the CLI/model default (issue #180). */
	reasoning?: ReasoningLevel;
	/**
	 * Project's optional custom prompt for this phase (`agents.planning.prompt`,
	 * issue #135) — appended to the static SWARM prompt as a supplement-only
	 * section. Omit for today's prompt exactly.
	 */
	customPrompt?: string;
	/** Deterministic Claude session handle assigned by the run row. */
	sessionId?: string;
	/** Resume this Claude session when its preserved worktree still exists. */
	resumeSessionId?: string;
	/**
	 * Whether to move the item to "ToDo" once the plan is posted. Defaults to
	 * `false` — a human reviews the plan and moves the item themselves. Always
	 * forced off for a spawned split-child item (see {@link SPLIT_CHILD_LABEL}),
	 * regardless of this value.
	 */
	autoAdvance?: boolean;
	/**
	 * Whether the planning agent may split a too-large item into smaller sibling
	 * tasks. Defaults to `true`. When off, the agent plans the item as a single
	 * task (today's behavior) and any `proposed_split.json` it writes is ignored.
	 */
	autoSplit?: boolean;
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
	/** The canonical status the item was moved to, or `undefined` when `autoAdvance` was off. */
	movedTo?: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
	/**
	 * Present when the agent split the task: the work-item IDs of the spawned
	 * siblings (in order) and whether the original item was re-scoped/renamed.
	 * Absent when the item was planned as a single task.
	 */
	split?: {
		subTaskItemIds: string[];
		mainTaskUpdated: boolean;
	};
	/**
	 * True when this run reused a preplanned split-child plan and skipped the
	 * agent CLI entirely (docs/OPTIMIZATION.md §3). The `agent` result is then a
	 * synthetic zero-usage record — no worktree was provisioned and no model was
	 * spent.
	 */
	preplanned?: boolean;
}

/**
 * Read and validate {@link PROPOSED_SPLIT_FILENAME} from the worktree, or return
 * `undefined` when the agent chose not to split (file absent, or present with no
 * `subTasks`). A malformed file throws — the agent was asked for an exact shape,
 * so a broken one is a failed run, not a silent "no split" (ai/CODING_STANDARDS.md
 * "Error handling").
 */
export function readProposedSplit(worktreePath: string): ProposedSplit | undefined {
	const splitPath = join(worktreePath, PROPOSED_SPLIT_FILENAME);
	if (!existsSync(splitPath)) return undefined;
	const raw = readFileSync(splitPath, 'utf8').trim();
	if (raw.length === 0) return undefined;
	const parsed = ProposedSplitSchema.parse(JSON.parse(raw));
	if (parsed.subTasks.length === 0) return undefined;
	return parsed;
}

/**
 * Comment posted on a spawned sibling so the board shows what happened: it came
 * from splitting the parent, it will be planned automatically, and — unlike a
 * normal planned task — it will NOT move to "ToDo" on its own. The human decides
 * when and in what order to start each sibling.
 */
export function splitChildCommentBody(parent: WorkItem): string {
	return [
		'## 🧩 Split from a larger task',
		'',
		`This task was split off from **${parent.title}** (${parent.url}) during planning,`,
		'because that work item was too large to implement well in a single pull request.',
		'',
		'SWARM will plan this task automatically. It will **not** move to **ToDo** by itself —',
		'move it there yourself when you want it started, in the order that suits you.',
	].join('\n');
}

/**
 * Wrap the raw plan in a comment body that marks it as SWARM's proposed plan.
 * The trailing hint depends on `autoAdvance`: when off (the default), it
 * tells the human to move the item to "ToDo" themselves to start
 * Implementation; when on, it says the item is moving there on its own, so a
 * human doesn't sit waiting for an action the phase already took.
 */
export function planCommentBody(plan: string, autoAdvance = DEFAULT_AUTO_ADVANCE): string {
	const hint = autoAdvance
		? '_Generated by SWARM (Planning phase). This item is moving to **ToDo** automatically to begin implementation._'
		: '_Generated by SWARM (Planning phase). Move this item to **ToDo** to begin implementation._';
	return ['## 🗺️ Proposed implementation plan', '', plan.trim(), '', '---', hint].join('\n');
}

/**
 * The patch to apply to the original item so it becomes the split's smaller
 * first task, containing only the fields the agent actually changed — or
 * `undefined` when title and description both match, so no needless write is
 * made.
 */
function buildMainTaskPatch(
	workItem: WorkItem,
	mainTask: ProposedSplit['mainTask'],
): { title?: string; description?: string } | undefined {
	if (!mainTask) return undefined;
	const patch: { title?: string; description?: string } = {};
	if (mainTask.title !== workItem.title) patch.title = mainTask.title;
	if (mainTask.description !== workItem.description) patch.description = mainTask.description;
	return patch.title === undefined && patch.description === undefined ? undefined : patch;
}

/**
 * Log a failed planning run's captured output before the phase throws, so the
 * worker (SWARM-17) that marks the job failed has the agent's own stdout/stderr
 * to diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}, so this can't blow up the log.
 */
function logAgentFailure(taskId: string, workItemId: string, agent: AgentCliResult): void {
	logger.error('Phase failed - Planning — agent output', {
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
 * Read and validate the plan the agent was told to write. Throws (after logging
 * the agent's captured output) when the file is missing or empty — a planning
 * run that didn't yield a plan is a failed job, not a soft miss
 * (ai/CODING_STANDARDS.md "Error handling"). Split out of {@link runPlanningPhase}
 * to keep that function's branching within the complexity budget.
 */
function readPlanOrThrow(
	worktreePath: string,
	cli: AgentCli,
	taskId: string,
	workItem: WorkItem,
	agent: AgentCliResult,
): string {
	const planPath = join(worktreePath, PROPOSED_PLAN_FILENAME);
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
	return plan;
}

/**
 * Apply a split: re-scope/rename the original item into the smaller first task
 * (when the agent asked), then spawn each sibling task in "Planning" — tagged so
 * its own Planning run won't auto-advance, with a comment explaining the split,
 * and with the parent-written plan embedded as a validated preplanned marker in
 * its issue body ({@link embedPreplanMarker}) so the sibling's own Planning run
 * reuses that plan instead of launching a fresh agent (docs/OPTIMIZATION.md §3).
 * Returns the spawned siblings' IDs (in order) and whether the original was
 * patched. Split out of {@link runPlanningPhase} for the same complexity-budget
 * reason as {@link readPlanOrThrow}.
 *
 * The marker is embedded via a follow-up `updateWorkItem` (not at creation)
 * because it binds the sibling's own backing-issue URL, which only exists once
 * the item is created. That embed (contract build + marker update) is wrapped in
 * a try/catch: a failure there is logged and swallowed so the sibling is still
 * created (and its split comment posted) — it simply stays unmarked and falls
 * back to a normal Planning run for that child, rather than failing the whole
 * parent run mid-loop (which a retry would then duplicate). The `createWorkItem`
 * and split comment are deliberately outside the catch — those are the split
 * itself, not the optimization, so their failures must still surface.
 */
async function applySplit(
	pm: PMProvider,
	parent: WorkItem,
	split: ProposedSplit,
): Promise<{ subTaskItemIds: string[]; mainTaskUpdated: boolean }> {
	const mainPatch = split.mainTask ? buildMainTaskPatch(parent, split.mainTask) : undefined;
	if (mainPatch) {
		await pm.updateWorkItem(parent.id, mainPatch);
	}
	// One id/timestamp for the whole split, so every child's marker is stamped
	// with the operation it came from (provenance; see PreplanContract).
	const splitId = randomUUID();
	const generatedAt = new Date().toISOString();
	const subTaskItemIds: string[] = [];
	for (const [childIndex, sub] of split.subTasks.entries()) {
		const sibling = await pm.createWorkItem({
			title: sub.title,
			description: sub.description,
			status: SIBLING_START_STATUS,
			labels: [SPLIT_CHILD_LABEL],
		});
		try {
			const contract = buildPreplanContract({
				splitId,
				childIndex,
				parentUrl: parent.url,
				itemUrl: sibling.url,
				humanDescription: sub.description,
				plan: sub.plan,
				generatedAt,
			});
			await pm.updateWorkItem(sibling.id, {
				description: embedPreplanMarker(sub.description, contract),
			});
		} catch (error) {
			logger.warn('Planning — failed to embed preplan marker; child will re-plan normally', {
				parentId: parent.id,
				siblingId: sibling.id,
				splitId,
				childIndex,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await pm.addComment(sibling.id, splitChildCommentBody(parent));
		subTaskItemIds.push(sibling.id);
	}
	return { subTaskItemIds, mainTaskUpdated: mainPatch !== undefined };
}

/**
 * Run the Planning phase for one work item. Provisions a detached worktree, runs
 * the planning agent to produce `proposed_plan.md`, and posts it as a comment on
 * the linked Issue. Whether the item then moves to "ToDo" is `autoAdvance`
 * (default `false`) — a human moves it themselves after reviewing the plan
 * unless the project opted into automatic advancement.
 *
 * When `autoSplit` (default `true`) is on and the agent judged the item too large,
 * it also writes `proposed_split.json`: the original item is re-scoped into the
 * smaller first task (`proposed_plan.md` is that task's plan) and the remaining
 * work is spawned as sibling items. Each sibling starts in "Planning" (so the
 * pm-status trigger plans it), is tagged with {@link SPLIT_CHILD_LABEL} so its own
 * Planning run never auto-advances, and gets a comment explaining the split — the
 * human then moves each sibling to "ToDo" in the order they choose. The original
 * (first task) still honors `autoAdvance` as usual, unless it is itself a
 * split-child.
 *
 * Throws if the agent exits non-zero or produces no plan — a planning run that
 * didn't yield a plan is a failed job, not a soft miss (ai/CODING_STANDARDS.md
 * "Error handling"), and the throw lets the worker mark the job failed. The
 * worktree is always removed, success or failure.
 */
/**
 * Acquire the read-only (detached-HEAD) checkout for the planning run. When
 * resuming a Claude session (`resumeSessionId`) it reuses the existing worktree
 * so the agent can `--resume` in place; if that worktree is gone (`reuse`
 * returns undefined) it falls through to a fresh detached provision. `resumed`
 * reports whether a session worktree was actually reused, so the caller only
 * threads the resume session id through when its checkout is really in place.
 */
async function acquirePlanningWorktree(
	worktrees: GitWorktreeManager,
	taskId: string,
	baseBranch: string,
	resumeSessionId: string | undefined,
): Promise<{ handle: WorktreeHandle; resumed: boolean }> {
	return acquireResumableWorktree(worktrees, taskId, baseBranch, true, resumeSessionId, () =>
		worktrees.provision(taskId, { detach: true }),
	);
}

/**
 * Synthetic agent result for a preplanned run that skipped the CLI entirely:
 * exit 0, no output, no usage, zero duration. The worker records it as a
 * completed run that consumed no model quota (`src/worker/consumer.ts`), which
 * is exactly the saving docs/OPTIMIZATION.md §3 is after.
 */
function skippedAgentResult(cli: AgentCli): AgentCliResult {
	return {
		cli,
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 0,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

/**
 * Complete a Planning run for a split child that already carries a valid
 * preplanned plan — post that plan as the plan comment (exactly what a normal
 * run would post) and honor the status behavior, without provisioning a worktree
 * or launching the agent. `effectiveAutoAdvance` is already forced off for a
 * split child, so this never moves the child to "ToDo" (issue #178: the child
 * remains in Planning and never auto-advances).
 */
async function completePreplannedRun(
	pm: PMProvider,
	workItem: WorkItem,
	plan: string,
	effectiveAutoAdvance: boolean,
	cli: AgentCli,
	taskId: string,
): Promise<PlanningPhaseResult> {
	const commentId = await pm.addComment(workItem.id, planCommentBody(plan, effectiveAutoAdvance));
	const movedTo = effectiveAutoAdvance ? NEXT_STATUS : undefined;
	if (movedTo) {
		await pm.moveWorkItem(workItem.id, movedTo);
	}
	logger.info('Phase finished - Planning (preplanned — agent skipped)', {
		taskId,
		workItemId: workItem.id,
		commentId,
		movedTo,
	});
	return { plan, commentId, agent: skippedAgentResult(cli), movedTo, preplanned: true };
}

export async function runPlanningPhase(
	options: RunPlanningPhaseOptions,
): Promise<PlanningPhaseResult> {
	const {
		project,
		workItem,
		taskId,
		pm,
		cli = DEFAULT_PLANNING_CLI,
		model,
		reasoning,
		customPrompt,
		sessionId,
		resumeSessionId,
		autoAdvance = DEFAULT_AUTO_ADVANCE,
		autoSplit = DEFAULT_AUTO_SPLIT,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	// A spawned split-child never auto-advances to "ToDo" on its own — the human
	// sequences the siblings — so its own Planning run forces autoAdvance off,
	// whatever the project config says (see SPLIT_CHILD_LABEL).
	const isSplitChild = workItem.labels.some((l) => l.name === SPLIT_CHILD_LABEL);
	const effectiveAutoAdvance = autoAdvance && !isSplitChild;

	// A split child whose parent already wrote its plan reuses it — no worktree,
	// no agent CLI (docs/OPTIMIZATION.md §3). A missing/malformed/stale/mismatched
	// or operator-invalidated marker falls back to a normal run below. The skip is
	// gated on isSplitChild: the marker is only ever written on split children, so
	// a valid marker on a non-split item (e.g. a human removed the label) is not
	// trusted to auto-advance — it falls through to a normal run.
	const preplan = evaluatePreplan(workItem);
	if (isPreplanSkip(preplan)) {
		if (isSplitChild) {
			logger.info('Phase started - Planning — reusing preplanned split-child plan', {
				taskId,
				workItemId: workItem.id,
				splitId: preplan.contract.splitId,
			});
			return completePreplannedRun(
				pm,
				workItem,
				preplan.contract.plan,
				effectiveAutoAdvance,
				cli,
				taskId,
			);
		}
		logger.warn('Planning — valid preplan marker on a non-split-child item; ignoring', {
			taskId,
			workItemId: workItem.id,
			splitId: preplan.contract.splitId,
		});
	} else if (preplan.fallbackReason) {
		logger.info('Planning — preplanned marker rejected, running agent normally', {
			taskId,
			workItemId: workItem.id,
			reason: preplan.fallbackReason,
		});
	}

	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	logger.info(`Phase started - Planning — running ${describeAgent(cli, model, reasoning)}`, {
		taskId,
		workItemId: workItem.id,
		cli,
		model,
		reasoning,
	});

	// Read-only checkout: detached HEAD, no task branch (see ProvisionOptions.detach).
	// Claude 2.1.207 also reattaches after recreating this exact path, but a missing
	// checkout intentionally takes the safer from-scratch path requested by #155.
	const { handle, resumed } = await acquirePlanningWorktree(
		worktrees,
		taskId,
		project.baseBranch,
		resumeSessionId,
	);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			model,
			reasoning,
			...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
			cwd: handle.path,
			args: [buildPlanningPrompt(workItem, autoSplit, customPrompt)],
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			logContext: { taskId, phase: 'planning', workItemId: workItem.id },
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, workItem.id, agent);
			const error = agentRunError(
				agent,
				`Planning agent (${cli}) exited with code ${agent.exitCode}`,
				` for task '${taskId}'`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		const plan = readPlanOrThrow(handle.path, cli, taskId, workItem, agent);

		// The agent may have decided to split (only honored when autoSplit is on).
		// The re-scope/rename and sibling spawns happen before the first task is
		// greenlit below, so autoAdvance never fires ahead of the siblings existing.
		const split = autoSplit ? readProposedSplit(handle.path) : undefined;

		const commentId = await pm.addComment(workItem.id, planCommentBody(plan, effectiveAutoAdvance));

		const splitResult = split ? await applySplit(pm, workItem, split) : undefined;

		const movedTo = effectiveAutoAdvance ? NEXT_STATUS : undefined;
		if (movedTo) {
			await pm.moveWorkItem(workItem.id, movedTo);
		}

		logger.info('Phase finished - Planning', {
			taskId,
			workItemId: workItem.id,
			commentId,
			movedTo,
			splitInto: splitResult?.subTaskItemIds.length,
		});

		return { plan, commentId, agent, movedTo, split: splitResult };
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'planning phase');
	}
}
