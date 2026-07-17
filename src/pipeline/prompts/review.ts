/**
 * Review-phase prompt construction (issue #135). Holds only the phase's static
 * instruction text; the orchestration (worktree, agent run, verdict delivery)
 * stays in `src/pipeline/review.ts`, which re-exports this for its existing
 * callers.
 */

import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { projectInstructionsSection } from '@/pipeline/prompts/custom-prompt.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';

/** The hand-off file the reviewer writes with its verdict (the phase's delivery contract). */
const REVIEW_VERDICT_FILENAME = HANDOFF_FILENAMES.review;

/**
 * Build the prompt handed to the review agent. It's told this is review-only
 * (findings, never fixes — mirroring Cascade's review agent, which is
 * hard-blocked from editing), to read the PR / linked issue / full diff, to
 * verify findings against the checkout before reporting them, and to record its
 * verdict to the hand-off file so this phase can validate the hand-off.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135),
 * appended after the SWARM instructions as a clearly delimited, supplement-only
 * section (empty when unset).
 */
export function buildReviewPrompt(
	context: {
		repo: string;
		prNumber: string;
		headSha: string;
	},
	delegationAllowed = false,
	customPrompt?: string,
): string {
	const { repo, prNumber, headSha } = context;
	return [
		'You are a senior code reviewer reviewing a pull request.',
		'',
		...pipelinePhaseGuard(delegationAllowed),
		...GH_IDENTITY_GUARD,
		'',
		'REVIEW ONLY. Do NOT edit files, fix code, commit, push, or change the repository',
		'in any way. When you find a problem, report it as a review finding — never fix it',
		'yourself.',
		'',
		`This worktree is checked out (detached) at ${headSha}, the head commit of PR`,
		`#${prNumber} in ${repo} on GitHub.`,
		'',
		'Do all of the following, in order:',
		`1. Read the PR and its discussion: \`gh pr view ${prNumber} --repo ${repo} --comments\`. If the PR body references an issue, read that too (\`gh issue view <n> --repo ${repo} --comments\`) — the issue and any plan posted on it are the ground truth for what was agreed.`,
		`2. Read the full diff: \`gh pr diff ${prNumber} --repo ${repo}\`. Review ALL changed files, not just the first few.`,
		'3. Confirm README.md remains accurate for the changes in this PR. If a configuration, architecture, workflow, or user-facing behavior change makes it stale, report the missing README update as a review finding.',
		'4. Verify before claiming: for each candidate finding, trace the exact failing scenario in the surrounding code of this checkout. Only report issues you can demonstrate — do not invent problems, pad the review with praise, or restate personal preferences as defects.',
		'Use the checked-out code and existing tests for that verification. Do not create disposable repositories or alter Git configuration to reproduce a concern, and never run destructive cleanup commands such as `rm -rf`.',
		'If an optional command is unavailable or blocked, continue the review with the evidence already available and still write the required hand-off file.',
		'5. Do not submit a review or perform any GitHub mutation. SWARM submits the decision after you exit.',
		`In particular, do not run \`gh pr review ${prNumber} --repo ${repo}\`, \`--approve\`, \`--request-changes\`, or \`--comment\`. GH_TOKEN is read-only context authentication; do not run gh auth switch.`,
		`6. Write "${REVIEW_VERDICT_FILENAME}" as JSON containing verdict (approve, request-changes, or comment), body (the final review body), and optional findings [{title,body}].`,
		'Do NOT `git add`/commit the hand-off.',
		'',
		'Do not merge the PR.',
		...projectInstructionsSection(customPrompt),
	].join('\n');
}
