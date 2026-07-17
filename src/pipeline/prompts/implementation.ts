/**
 * Implementation-phase prompt construction (issue #135). Holds only the phase's
 * static instruction text; the orchestration (worktree, agent run, delivery, PM
 * moves) stays in `src/pipeline/implementation.ts`, which re-exports these for
 * its existing callers.
 */

import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { projectInstructionsSection } from '@/pipeline/prompts/custom-prompt.js';
import type { WorkItem } from '@/pm/types.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';

/** The hand-off file the implementer writes with the opened-PR details (the phase's delivery contract). */
const OPENED_PR_FILENAME = HANDOFF_FILENAMES.implementation;

/**
 * The file the implementer writes instead of a PR when a genuine external
 * prerequisite blocks the work. Read back by `readBlockedReason`
 * (`src/pipeline/implementation.ts`); lives here because the prompt names it.
 */
export const BLOCKED_REASON_FILENAME = 'blocked_reason.md';

/**
 * Build the prompt handed to the implementation agent. It's told to implement the
 * work item (following the plan the Planning phase posted on the linked Issue),
 * verify with lint/typecheck/tests, and record the prepared change for SWARM to
 * deliver.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135):
 * appended after the SWARM instructions and before the work-item context as a
 * clearly delimited, supplement-only section (empty when unset).
 */
export function buildImplementationPrompt(
	workItem: WorkItem,
	context: { repo: string; taskId: string; branch: string; baseBranch: string },
	delegationAllowed = false,
	customPrompt?: string,
): string {
	const { repo, branch, baseBranch } = context;
	return [
		'You are a senior software engineer implementing a work item end to end.',
		'',
		...pipelinePhaseGuard(delegationAllowed),
		...GH_IDENTITY_GUARD,
		'',
		`You are on branch "${branch}", a fresh branch cut from "${baseBranch}" in a git`,
		'worktree whose root is your current working directory. The repository is',
		`${repo} on GitHub.`,
		'',
		'Do all of the following, in order:',
		`1. Read the linked issue and plan with \`gh issue view ${context.taskId} --repo ${repo} --comments\`, then explore the repository and implement it.`,
		"3. Definition of enough: meet the work item's agreed acceptance criteria with the smallest durable change. Do not add speculative features, broad refactors, or exhaustive test coverage merely because adjacent code is untested. Add or update focused tests for changed stable behavior, regressions, public/critical paths, and bug fixes; leave volatile or explicitly out-of-scope coverage alone unless the issue/plan requires it.",
		'4. Run the project lint, type-check, and the relevant tests; fix whatever they surface before continuing.',
		'5. Do not commit, push, open a pull request, or run any GitHub mutation. SWARM delivers the prepared tree after you exit.',
		`Specifically, do not run \`git push -u origin ${branch}\` or \`gh pr create --base ${baseBranch} --head ${branch}\`; SWARM constructs the PR with \`Closes #${context.taskId}\`. GH_TOKEN is read-only context authentication; do not run gh auth switch.`,
		`6. Write "${OPENED_PR_FILENAME}" as JSON with: summary (PR-ready text), verification (an array of {command,outcome:"passed"}), commitSubject (a conventional-commit subject), limitations (an array), and readyForDelivery:true. Do not track this file.`,
		'Do NOT `git add`/commit the hand-off file.',
		`If a genuine external prerequisite blocks implementation (for example, a required PR has not merged), do not open a placeholder PR. Instead, write a concise, human-readable explanation and the actionable next step to "${BLOCKED_REASON_FILENAME}" at the worktree root, then stop. Do NOT commit that file.`,
		'',
		'After step 7, STOP immediately and exit. Do not wait for a review, review the PR,',
		'respond to a review, post any additional PR comment, or invoke another agent.',
		'SWARM runs Review and Respond-to-review as separate phases after you exit.',
		'',
		'Do not merge the PR. Keep the change scoped to the work item.',
		...projectInstructionsSection(customPrompt),
		'',
		'--- WORK ITEM ---',
		`Title: ${workItem.title}`,
		`URL: ${workItem.url}`,
		'',
		'Description:',
		workItem.description || '(no description provided)',
	].join('\n');
}
