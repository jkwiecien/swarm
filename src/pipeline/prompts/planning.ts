/**
 * Planning-phase prompt construction (issue #135). Holds only the phase's static
 * instruction text and the hand-off filenames the prompt names; the phase
 * orchestration (worktree, agent run, PM moves, splitting) stays in
 * `src/pipeline/planning.ts`, which re-exports these for its existing callers.
 */

import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { projectInstructionsSection } from '@/pipeline/prompts/custom-prompt.js';
import type { WorkItem } from '@/pm/types.js';

/** The file the planning agent is instructed to write its plan to, at the worktree root. */
export const PROPOSED_PLAN_FILENAME = 'proposed_plan.md';

/**
 * The file the planning agent writes when it decides the task is too large for
 * a single PR and should be split (see {@link buildPlanningPrompt}). Absent (or
 * empty `subTasks`) means "no split — plan as a single task". Read-and-validated
 * by `readProposedSplit` (`src/pipeline/planning.ts`); `proposed_plan.md` still
 * carries the plan for the (now-smaller) first task the original item becomes.
 */
export const PROPOSED_SPLIT_FILENAME = 'proposed_split.json';

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
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135):
 * appended after the SWARM instructions and before the work-item context as a
 * clearly delimited, supplement-only section (empty when unset).
 */
export function buildPlanningPrompt(
	workItem: WorkItem,
	allowSplit = false,
	delegationAllowed = false,
	customPrompt?: string,
): string {
	const lines = [
		'You are a senior software architect creating a detailed implementation plan.',
		'',
		...pipelinePhaseGuard(delegationAllowed),
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
			'  - You have already explored the repository to plan the first task. REUSE that',
			'    analysis: write a concise implementation plan for EVERY other task now, while',
			'    that context is fresh, so each one does not have to re-explore the repo later.',
			`  - Write "${PROPOSED_SPLIT_FILENAME}" as JSON of this exact shape:`,
			'      {',
			'        "mainTask": { "title": "<first task\'s title>", "description": "<its scope>" },',
			'        "subTasks": [',
			'          {',
			'            "title": "<next task>",',
			'            "description": "<what it covers, self-contained>",',
			'            "plan": "<concise Markdown implementation plan for this task>"',
			'          }',
			'        ]',
			'      }',
			'    "mainTask" is OPTIONAL — include it only to rename/re-scope the original item;',
			'    omit it to keep the original title/description.',
			'    Each "subTasks" entry is a task planned separately later. Write its "description"',
			'    complete enough to stand on its own, and its "plan" (concise GitHub-flavored',
			'    Markdown) covering:',
			'      * self-contained scope and acceptance criteria;',
			'      * anything intentionally left out of scope;',
			'      * the relevant files, symbols, and existing patterns to follow;',
			'      * dependencies on the preceding split tasks (what must land first);',
			'      * an ordered implementation outline;',
			'      * focused verification guidance (the checks/tests to run).',
			`  - Do NOT write "${PROPOSED_SPLIT_FILENAME}" (or write it with an empty`,
			'    "subTasks" array) when the item is already right-sized — then just write the',
			`    single "${PROPOSED_PLAN_FILENAME}" as usual.`,
		);
	}

	lines.push(
		'',
		`Write the plan to a file named "${PROPOSED_PLAN_FILENAME}" at the root of this`,
		'worktree, as GitHub-flavored Markdown.',
		...projectInstructionsSection(customPrompt),
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
