/**
 * Review phase (PROJECT.md §5.3, ai/ARCHITECTURE.md "Pipeline phases" #3).
 *
 * A PR opens / its check suite passes → the worker runs this: provision a
 * read-only worktree at the PR's head commit, spin up Claude Code as the
 * reviewer persona to read the diff and verify findings against the checkout,
 * and have it submit a formal GitHub PR review — mirroring Cascade's
 * review-agent trigger on `check_suite` success.
 *
 * The review must be a *formal* review (`gh pr review`), not a plain comment:
 * the Respond-to-review phase (SWARM-21) is driven by the
 * `pull_request_review` webhook that only a submitted review emits, and its
 * `changes_requested` state is what routes work back to the implementer
 * (ai/ARCHITECTURE.md "Pipeline phases" #4). That in turn forces the persona
 * plumbing here: GitHub refuses to let a PR's author review their own PR, so
 * the agent's `gh` must authenticate as the *reviewer* persona, not the
 * implementer who opened it. SWARM's harness has no gadget layer (unlike
 * Cascade's `CreatePRReview`), so the reviewer token is resolved from the
 * project's credentials and handed to the CLI process as `GH_TOKEN` — the env
 * var `gh` reads before any ambient login. The token crosses exactly one
 * boundary (resolution → subprocess env), never function layers
 * (ai/CODING_STANDARDS.md "Error handling" / credential scoping).
 *
 * The checkout is detached at the PR's head SHA, like Planning's throwaway
 * checkout: review is read-only, and checking out the PR's `issue-<n>` branch
 * would collide with the local branch the Implementation phase's cleanup
 * leaves behind (see `runImplementationPhase`'s re-run note). The head SHA —
 * which the `pull_request` and `check_suite` webhooks both carry — also pins
 * the review to exactly the commit CI validated.
 *
 * No PM interaction: the item already sits at "In review" (the Implementation
 * phase moved it), and a submitted review doesn't change board status — any
 * verdict drives SWARM-21 (the implementer always responds, even to an
 * approval), and merging is still left to a human.
 *
 * This is the phase's orchestration only, same as Planning/Implementation. It
 * composes `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15) and
 * `runAgentCli` (SWARM-16), and takes the PR coordinates as inputs rather than
 * reaching for a queue or webhook payload. The trigger handler that matches
 * `pull_request` opened / `check_suite` success events and calls this —
 * including the aggregate-check-state and dedup policy Cascade's
 * `check-suite-success` trigger encodes — is its own issue, wired via
 * `src/triggers/builtins.ts` when it lands. That handler must accept only
 * same-repo PRs: `provision`'s best-effort `git fetch origin` fetches branch
 * refs, so a fork PR's head SHA is unreachable here and the detached checkout
 * would fail the job.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getPersonaToken } from '@/config/provider.js';
import type { ProjectConfig } from '@/config/schema.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { agentRunError } from '@/harness/agent-failure.js';
import { logger } from '@/lib/logger.js';
import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { PIPELINE_PHASE_GUARD } from '@/pipeline/agent-scope.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the review agent is instructed to write its submitted verdict to, at the worktree root. */
export const REVIEW_VERDICT_FILENAME = 'review_verdict.txt';

/**
 * The verdicts the agent may submit — `gh pr review`'s three event flags. The
 * agent hands back which one it used via {@link REVIEW_VERDICT_FILENAME};
 * anything else is a failed run, not a fourth outcome.
 */
export const REVIEW_VERDICTS = ['approve', 'request-changes', 'comment'] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Claude Code is SWARM's review agent (PROJECT.md §5.3) — run as the reviewer persona. */
const DEFAULT_REVIEW_CLI: AgentCli = 'claude';

/**
 * Cap on captured agent output, so a chatty/runaway review run can't grow the
 * worker's memory without bound. The verdict is read from
 * {@link REVIEW_VERDICT_FILENAME}, not from stdout, so truncating the captured
 * stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunReviewPhaseOptions {
	/** The SWARM project whose repo the PR belongs to. */
	project: ProjectConfig;
	/** The number of the PR under review. */
	prNumber: string;
	/**
	 * The PR's head commit — what the detached checkout points at and what the
	 * review covers. Both triggering webhooks carry it (`pull_request.head.sha` /
	 * `check_suite.head_sha`), and pinning to it means the agent reviews exactly
	 * the commit whose checks passed, even if the branch moves mid-run.
	 */
	headSha: string;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`). Passed explicitly
	 * rather than derived from `prNumber`: the worker that dequeues the job owns
	 * task naming, and a review worktree must not collide with an
	 * implementation/respond worktree for the same change.
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
	/** Injectable reviewer-token resolver — defaults to {@link getPersonaToken}; overridden in tests. */
	getToken?: typeof getPersonaToken;
}

export interface ReviewPhaseResult {
	/** The verdict the agent submitted, read from {@link REVIEW_VERDICT_FILENAME}. */
	verdict: ReviewVerdict;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
}

/**
 * Build the prompt handed to the review agent. It's told this is review-only
 * (findings, never fixes — mirroring Cascade's review agent, which is
 * hard-blocked from editing), to read the PR / linked issue / full diff, to
 * verify findings against the checkout before reporting them, to submit
 * exactly one formal review via `gh pr review`, and to record which verdict it
 * submitted to {@link REVIEW_VERDICT_FILENAME} so this phase can validate the
 * hand-off.
 */
export function buildReviewPrompt(context: {
	repo: string;
	prNumber: string;
	headSha: string;
}): string {
	const { repo, prNumber, headSha } = context;
	return [
		'You are a senior code reviewer reviewing a pull request.',
		'',
		...PIPELINE_PHASE_GUARD,
		'',
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
		`5. Submit exactly ONE formal review, non-interactively: write the review body to a scratch file (e.g. review_body.md), then run \`gh pr review ${prNumber} --repo ${repo} --body-file <file>\` with exactly one of \`--approve\` (nothing worth blocking on), \`--request-changes\` (correctness bugs or other issues that must be fixed before merge), or \`--comment\` (non-blocking questions/suggestions only).`,
		`6. Write the verdict you submitted — exactly one of \`approve\`, \`request-changes\`, or \`comment\`, and nothing else — to a file named "${REVIEW_VERDICT_FILENAME}" at the root of this worktree. Do NOT \`git add\`/commit this file (or the body scratch file) — they are scratch hand-offs read by SWARM, not part of the PR.`,
		'',
		'Do not merge the PR — a human does that.',
	].join('\n');
}

/**
 * Log a failed review run's captured output before the phase throws, so the
 * worker that marks the job failed has the agent's own stdout/stderr to
 * diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, prNumber: string, agent: AgentCliResult): void {
	logger.error('Phase failed - Review — agent output', {
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
 * Run the Review phase for one PR. Resolves the reviewer persona's token,
 * provisions a detached worktree at the PR's head SHA, runs the review agent
 * to read the diff and submit a formal PR review as the reviewer, and
 * validates the verdict it handed back.
 *
 * Throws if the reviewer token is missing (resolved *before* provisioning —
 * without it the agent could only act as the PR's own author, which GitHub
 * rejects), if the agent exits non-zero, or if it produced no recognizable
 * verdict — a review run that didn't verifiably submit a review is a failed
 * job, not a soft miss (ai/CODING_STANDARDS.md "Error handling"). The worktree
 * is always removed once provisioned, success or failure; the submitted review
 * lives on GitHub and is unaffected.
 */
export async function runReviewPhase(options: RunReviewPhaseOptions): Promise<ReviewPhaseResult> {
	const {
		project,
		prNumber,
		headSha,
		taskId,
		cli = DEFAULT_REVIEW_CLI,
		model,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
		getToken = getPersonaToken,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	logger.info(`Phase started - Review — running ${describeAgent(cli, model)}`, {
		taskId,
		prNumber,
		headSha,
		cli,
		model,
	});

	// Resolved first: a missing reviewer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	const reviewerToken = await getToken(project, 'reviewer');

	// Read-only checkout pinned to the reviewed commit (see the module header for
	// why detached-at-SHA rather than the PR branch).
	const handle = await worktrees.provision(taskId, { detach: true, baseBranch: headSha });
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			model,
			cwd: handle.path,
			args: [buildReviewPrompt({ repo: project.repo, prNumber, headSha })],
			// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
			// call the agent makes acts as the reviewer persona.
			env: { GH_TOKEN: reviewerToken },
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			logContext: { taskId, phase: 'review', prNumber, headSha },
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			throw agentRunError(
				agent,
				`Review agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
		}

		const verdictPath = join(handle.path, REVIEW_VERDICT_FILENAME);
		if (!existsSync(verdictPath)) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Review agent (${cli}) did not write ${REVIEW_VERDICT_FILENAME} for PR #${prNumber}`,
			);
		}
		const rawVerdict = readFileSync(verdictPath, 'utf8').trim();
		if (rawVerdict.length === 0) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Review agent (${cli}) wrote an empty ${REVIEW_VERDICT_FILENAME} for PR #${prNumber}`,
			);
		}
		// Case-tolerant ("Approve" happens) but otherwise strict: an unknown verdict
		// means the hand-off contract broke, and pretending the review happened would
		// stall the pipeline silently.
		const verdict = rawVerdict.toLowerCase() as ReviewVerdict;
		if (!REVIEW_VERDICTS.includes(verdict)) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Review agent (${cli}) wrote unrecognized verdict '${rawVerdict}' to ${REVIEW_VERDICT_FILENAME} for PR #${prNumber} (expected one of: ${REVIEW_VERDICTS.join(', ')})`,
			);
		}

		logger.info('Phase finished - Review', { taskId, prNumber, headSha, verdict });

		return { verdict, agent };
	} finally {
		// Swallow-and-log: a cleanup failure must not mask the run's outcome
		// (a successful phase turning into a reported failure, or a genuine
		// error being replaced by the cleanup error).
		try {
			await worktrees.cleanup(taskId);
		} catch (error) {
			logger.error('review phase: worktree cleanup failed', {
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
