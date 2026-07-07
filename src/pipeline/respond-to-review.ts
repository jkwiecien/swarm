/**
 * Respond-to-review phase (PROJECT.md §5.4, ai/ARCHITECTURE.md "Pipeline phases" #4).
 *
 * The reviewer persona submits a review with `changes_requested` → the worker
 * runs this: provision a worktree on the PR's existing task branch, spin up
 * Claude Code as the implementer to read the batched review, and for each point
 * either fix the code (Path A) or push back with a rationale (Path B) —
 * mirroring Cascade's `respond-to-review` agent and its "wait for the final
 * submitted review, not individual line comments" rule. Matching the event
 * (`pull_request_review` `submitted`, authored by the *reviewer* persona — the
 * `getPersonaForLogin` routing in `src/router/adapters/github.ts`) is the
 * trigger handler's job (SWARM-53), not this phase's: it receives a review to
 * respond to, already vetted.
 *
 * The checkout is the PR branch itself (`provision`'s `createBranch: false`
 * seam) — unlike Review's detached throwaway, the implementer commits and
 * pushes here. That checkout target must already exist as a *local* branch:
 * `git worktree add <path> <branch>` doesn't DWIM remote-only branches, so this
 * phase leans on the Implementation phase having created `issue-<n>` in the
 * same `repoRoot` and its cleanup leaving the branch behind (see
 * `runImplementationPhase`'s re-run note — the leftover branch is load-bearing
 * here). The local branch can still be *stale* — origin moves when a human
 * co-pushes, or on the second respond round — so the prompt's first step
 * fast-forwards it; a diverged branch fails that sync (and the job) rather than
 * letting the agent respond against code the reviewer never saw.
 *
 * No token plumbing, unlike Review: the implementer *is* the PR's author, which
 * is exactly what the worker's ambient `gh`/git credentials already are (the
 * Review phase's GH_TOKEN override exists only because GitHub refuses
 * self-review — see `runReviewPhase`'s header). No PM interaction either: the
 * item already sits at "In review" and a response doesn't change board status —
 * the reviewer's next round (or a human merge) is what moves things next.
 *
 * This is the phase's orchestration only, same as the other three. It composes
 * `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15) and
 * `runAgentCli` (SWARM-16), and takes the PR/review coordinates as inputs
 * rather than reaching for a queue or webhook payload.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProjectConfig } from '@/config/schema.js';
import { type AgentCli, type AgentCliResult, runAgentCli } from '@/harness/agent-cli.js';
import { logger } from '@/lib/logger.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the respond agent is instructed to write its outcome to, at the worktree root. */
export const RESPOND_OUTCOME_FILENAME = 'respond_outcome.txt';

/**
 * The outcomes the agent may report — PROJECT.md §5.4's two paths. `fixed`
 * means at least one fix commit was pushed (even if some points were pushed
 * back); `pushed-back` means no code changed and every point got a rationale
 * reply instead. The agent hands back which one applied via
 * {@link RESPOND_OUTCOME_FILENAME}; anything else is a failed run, not a third
 * outcome.
 */
export const RESPOND_OUTCOMES = ['fixed', 'pushed-back'] as const;

export type RespondOutcome = (typeof RESPOND_OUTCOMES)[number];

/** Claude Code is SWARM's implementer agent (PROJECT.md §5.4) — the persona that responds. */
const DEFAULT_RESPOND_CLI: AgentCli = 'claude';

/**
 * Cap on captured agent output, so a chatty/runaway respond run can't grow the
 * worker's memory without bound. The outcome is read from
 * {@link RESPOND_OUTCOME_FILENAME}, not from stdout, so truncating the captured
 * stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunRespondToReviewPhaseOptions {
	/** The SWARM project whose repo the PR belongs to. */
	project: ProjectConfig;
	/** The number of the PR the review was submitted on. */
	prNumber: string;
	/**
	 * The PR's head branch (`pull_request.head.ref`) — the existing task branch
	 * the worktree checks out and the agent pushes fixes to.
	 */
	prBranch: string;
	/**
	 * The submitted review's numeric ID (`review.id` from the
	 * `pull_request_review` webhook) — pins the agent to the one batched review
	 * it must respond to, rather than whatever `gh pr view` surfaces last.
	 */
	reviewId: string;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`). Passed explicitly
	 * rather than derived from `prNumber`: the worker that dequeues the job owns
	 * task naming, and a respond worktree must not collide with a review
	 * worktree for the same change.
	 */
	taskId: string;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Claude Code. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/** Kill the agent run after this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the agent run. */
	signal?: AbortSignal;
	/** Injectable agent runner — defaults to {@link runAgentCli}; overridden in tests. */
	runAgent?: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	/** Injectable env-grafting step — defaults to {@link graftEnvironment}; overridden in tests. */
	graft?: typeof graftEnvironment;
}

export interface RespondToReviewPhaseResult {
	/** The outcome the agent reported, read from {@link RESPOND_OUTCOME_FILENAME}. */
	outcome: RespondOutcome;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
}

/**
 * Build the prompt handed to the respond agent. It's told it authored the PR
 * and is answering its reviewer: sync the branch first, read the pinned review
 * (summary body plus its batched line comments — the review API, not the issue
 * comment stream), address every point as either a fix or a reasoned
 * push-back, verify fixes before pushing, reply on the PR point by point, and
 * record which outcome applied to {@link RESPOND_OUTCOME_FILENAME} so this
 * phase can validate the hand-off.
 */
export function buildRespondToReviewPrompt(context: {
	repo: string;
	prNumber: string;
	prBranch: string;
	reviewId: string;
}): string {
	const { repo, prNumber, prBranch, reviewId } = context;
	return [
		'You are a senior software engineer responding to a code review on a pull request',
		'you authored.',
		'',
		`This worktree has branch "${prBranch}" checked out — the head branch of PR`,
		`#${prNumber} in ${repo} on GitHub. A reviewer has submitted a review requesting`,
		'changes.',
		'',
		'Do all of the following, in order:',
		`1. Sync the branch with what the reviewer saw: \`git pull --ff-only origin ${prBranch}\`. If this fails for any reason (diverged branch, deleted remote branch, network error), stop and exit non-zero rather than responding against stale code.`,
		`2. Read the submitted review you are responding to: \`gh api repos/${repo}/pulls/${prNumber}/reviews/${reviewId}\` for its summary body, and \`gh api repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments\` for its line comments. Read the PR discussion for context too: \`gh pr view ${prNumber} --repo ${repo} --comments\`.`,
		'3. Address EVERY point the review raises. For each one, either:',
		'   - fix the code (keep the fix surgical — only go broader when the reviewer clearly asks for it), or',
		'   - if the point is mistaken, push back: no code change, but a clear rationale in your reply below.',
		`4. If you changed code: run the project lint, type-check, and the relevant tests; fix whatever they surface. Then commit with a conventional-commit message and push: \`git push origin ${prBranch}\` (explicit remote/branch — the checkout may have no upstream configured, e.g. on a human-created PR branch).`,
		`5. Reply on the PR with exactly ONE comment answering the review point by point, non-interactively: write the reply to a scratch file (e.g. respond_body.md), then run \`gh pr comment ${prNumber} --repo ${repo} --body-file <file>\`. For each point say whether you fixed it (name the commit) or are pushing back (give the rationale).`,
		`6. Write the outcome — exactly \`fixed\` if you pushed at least one fix commit, or exactly \`pushed-back\` if you changed no code, and nothing else — to a file named "${RESPOND_OUTCOME_FILENAME}" at the root of this worktree. Do NOT \`git add\`/commit this file (or the reply scratch file) — they are scratch hand-offs read by SWARM, not part of the PR.`,
		'',
		'Do not merge the PR, and do not submit a review of your own — you are the author.',
	].join('\n');
}

/**
 * Log a failed respond run's captured output before the phase throws, so the
 * worker that marks the job failed has the agent's own stdout/stderr to
 * diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, prNumber: string, agent: AgentCliResult): void {
	logger.error('respond-to-review phase: agent failed', {
		taskId,
		prNumber,
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
 * Run the Respond-to-review phase for one submitted review. Provisions a
 * worktree on the PR's existing branch, runs the implementer agent to address
 * the batched review — fixing code or pushing back point by point — and
 * validates the outcome it handed back.
 *
 * Throws if the agent exits non-zero (including the prompt's deliberate
 * diverged-branch bail-out) or if it produced no recognizable outcome — a
 * respond run that didn't verifiably answer the review is a failed job, not a
 * soft miss (ai/CODING_STANDARDS.md "Error handling"). The worktree is always
 * removed once provisioned, success or failure; pushed fixes and the PR reply
 * live on GitHub and are unaffected.
 */
export async function runRespondToReviewPhase(
	options: RunRespondToReviewPhaseOptions,
): Promise<RespondToReviewPhaseResult> {
	const {
		project,
		prNumber,
		prBranch,
		reviewId,
		taskId,
		cli = DEFAULT_RESPOND_CLI,
		model,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	logger.info('respond-to-review phase: start', { taskId, prNumber, prBranch, reviewId, cli });

	// The existing task branch, not a fresh one — the agent commits and pushes to
	// the PR here (see the module header for the local-branch precondition).
	const handle = await worktrees.provision(taskId, { createBranch: false, branch: prBranch });
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			model,
			cwd: handle.path,
			args: [buildRespondToReviewPrompt({ repo: project.repo, prNumber, prBranch, reviewId })],
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-review agent (${cli}) exited with code ${agent.exitCode}${
					agent.timedOut ? ' (timed out)' : ''
				} for PR #${prNumber}`,
			);
		}

		const outcomePath = join(handle.path, RESPOND_OUTCOME_FILENAME);
		if (!existsSync(outcomePath)) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-review agent (${cli}) did not write ${RESPOND_OUTCOME_FILENAME} for PR #${prNumber}`,
			);
		}
		const rawOutcome = readFileSync(outcomePath, 'utf8').trim();
		if (rawOutcome.length === 0) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-review agent (${cli}) wrote an empty ${RESPOND_OUTCOME_FILENAME} for PR #${prNumber}`,
			);
		}
		// Case-tolerant ("Fixed" happens) but otherwise strict: an unknown outcome
		// means the hand-off contract broke, and pretending the response happened
		// would stall the pipeline silently.
		const outcome = rawOutcome.toLowerCase() as RespondOutcome;
		if (!RESPOND_OUTCOMES.includes(outcome)) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-review agent (${cli}) wrote unrecognized outcome '${rawOutcome}' to ${RESPOND_OUTCOME_FILENAME} for PR #${prNumber} (expected one of: ${RESPOND_OUTCOMES.join(', ')})`,
			);
		}

		logger.info('respond-to-review phase: done', { taskId, prNumber, prBranch, outcome });

		return { outcome, agent };
	} finally {
		// Swallow-and-log: a cleanup failure must not mask the run's outcome
		// (a successful phase turning into a reported failure, or a genuine
		// error being replaced by the cleanup error).
		try {
			await worktrees.cleanup(taskId);
		} catch (error) {
			logger.error('respond-to-review phase: worktree cleanup failed', {
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
