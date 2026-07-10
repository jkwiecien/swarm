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
import { logger } from '@/lib/logger.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the planning agent is instructed to write its plan to, at the worktree root. */
export const PROPOSED_PLAN_FILENAME = 'proposed_plan.md';

/**
 * The file the planning agent writes when it decides the task is too large for
 * a single PR and should be split (see {@link buildPlanningPrompt}). Absent (or
 * empty `subTasks`) means "no split — plan as a single task". Read-and-validated
 * by {@link readProposedSplit}; `proposed_plan.md` still carries the plan for the
 * (now-smaller) first task the original item becomes.
 */
export const PROPOSED_SPLIT_FILENAME = 'proposed_split.json';

/**
 * Label applied to every sibling item Planning spawns when it splits a task.
 * Two jobs: it's a visible marker on the board that an item came from a split,
 * and it's the signal {@link runPlanningPhase} reads to force `autoAdvance` off
 * for that item's own Planning run — a split-off task must never move itself to
 * "ToDo", no matter how the workflow is configured (the human sequences them).
 */
export const SPLIT_CHILD_LABEL = 'swarm:split-child';

/** One task a split produces: enough to create/plan it, no more. */
const SplitTaskSchema = z.object({
	title: z.string().trim().min(1),
	description: z.string(),
});

/**
 * Shape of {@link PROPOSED_SPLIT_FILENAME}. `mainTask` optionally re-scopes/renames
 * the original item into the smaller first task; `subTasks` are the siblings to
 * spawn (each planned on its own afterwards). Zod is the source of truth for the
 * on-disk contract (ai/CODING_STANDARDS.md "Zod as source of truth").
 */
const ProposedSplitSchema = z.object({
	mainTask: SplitTaskSchema.optional(),
	subTasks: z.array(SplitTaskSchema).default([]),
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
const DEFAULT_PLANNING_CLI: AgentCli = 'claude';

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
}

/**
 * Build the prompt handed to the planning agent. It's told to explore the repo
 * and write a step-by-step implementation plan to `proposed_plan.md` — and, since
 * this is a read-only phase, explicitly *not* to modify code or implement
 * anything (mirroring Cascade's planning agent, which is read/write-to-PM only).
 *
 * When `allowSplit` is on (the project's `pipeline.planning.autoSplit`), the
 * agent is additionally told to judge whether the work is too large for a single
 * focused PR and, if so, to split it: `proposed_plan.md` then covers only the
 * first (now-smaller) task, and `proposed_split.json` lists the remaining sibling
 * tasks (see {@link PROPOSED_SPLIT_FILENAME}). A right-sized task is left whole.
 */
export function buildPlanningPrompt(workItem: WorkItem, allowSplit = false): string {
	const lines = [
		'You are a senior software architect creating a detailed implementation plan.',
		'',
		'PLANNING ONLY. Do NOT implement, edit, or create any source files, and do NOT',
		'run any command that changes the repository. Your sole deliverable is a plan',
		`(the file(s) named below at the root of this worktree — nothing else).`,
		'',
		'Explore this repository to understand its existing patterns and conventions,',
		'then write a concrete, step-by-step implementation plan for the work item below.',
		'The plan must cover: the files to add/change, the approach, the testing strategy,',
		'and anything intentionally left out of scope.',
	];

	if (allowSplit) {
		lines.push(
			'',
			'FIRST, judge the size of this work item. If it is too large to implement well',
			'in a single focused pull request, SPLIT it into smaller, independently-shippable',
			'tasks ordered so each builds on the last:',
			`  - Write "${PROPOSED_PLAN_FILENAME}" as the plan for ONLY the FIRST task — the`,
			'    smaller piece this item should become. It may be a re-scoped, renamed version',
			'    of the original.',
			`  - Write "${PROPOSED_SPLIT_FILENAME}" as JSON of this exact shape:`,
			'      {',
			'        "mainTask": { "title": "<first task\'s title>", "description": "<its scope>" },',
			'        "subTasks": [',
			'          { "title": "<next task>", "description": "<what it covers, self-contained>" }',
			'        ]',
			'      }',
			'    "mainTask" is OPTIONAL — include it only to rename/re-scope the original item;',
			'    omit it to keep the original title/description. Each "subTasks" entry is planned',
			'    separately later, so write a description complete enough to plan on its own.',
			`  - Do NOT write "${PROPOSED_SPLIT_FILENAME}" (or write it with an empty`,
			'    "subTasks" array) when the item is already right-sized — then just write the',
			`    single "${PROPOSED_PLAN_FILENAME}" as usual.`,
		);
	}

	lines.push(
		'',
		`Write the plan to a file named "${PROPOSED_PLAN_FILENAME}" at the root of this`,
		'worktree, as GitHub-flavored Markdown.',
		'',
		'--- WORK ITEM ---',
		`Title: ${workItem.title}`,
		`URL: ${workItem.url}`,
		'',
		'Description:',
		workItem.description || '(no description provided)',
	);
	return lines.join('\n');
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
 * its own Planning run won't auto-advance, and with a comment explaining the
 * split. Returns the spawned siblings' IDs (in order) and whether the original
 * was patched. Split out of {@link runPlanningPhase} for the same
 * complexity-budget reason as {@link readPlanOrThrow}.
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
	const subTaskItemIds: string[] = [];
	for (const sub of split.subTasks) {
		const sibling = await pm.createWorkItem({
			title: sub.title,
			description: sub.description,
			status: SIBLING_START_STATUS,
			labels: [SPLIT_CHILD_LABEL],
		});
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
		autoAdvance = DEFAULT_AUTO_ADVANCE,
		autoSplit = DEFAULT_AUTO_SPLIT,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	// A spawned split-child never auto-advances to "ToDo" on its own — the human
	// sequences the siblings — so its own Planning run forces autoAdvance off,
	// whatever the project config says (see SPLIT_CHILD_LABEL).
	const isSplitChild = workItem.labels.some((l) => l.name === SPLIT_CHILD_LABEL);
	const effectiveAutoAdvance = autoAdvance && !isSplitChild;

	logger.info(`Phase started - Planning — running ${describeAgent(cli, model)}`, {
		taskId,
		workItemId: workItem.id,
		cli,
		model,
	});

	// Read-only checkout: detached HEAD, no task branch (see ProvisionOptions.detach).
	const handle = await worktrees.provision(taskId, { detach: true });
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			model,
			cwd: handle.path,
			args: [buildPlanningPrompt(workItem, autoSplit)],
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, workItem.id, agent);
			throw agentRunError(
				agent,
				`Planning agent (${cli}) exited with code ${agent.exitCode}`,
				` for task '${taskId}'`,
			);
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
