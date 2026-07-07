/**
 * Respond-to-CI phase (ai/ARCHITECTURE.md "Pipeline phases" — respond-to-ci).
 *
 * A PR's check suite completes with a failure → the worker runs this: provision
 * a worktree on the PR's existing task branch, spin up Claude Code as the
 * implementer to read the failing checks, and fix the build — pushing a fix
 * commit — or, if the failure isn't something a code change should address
 * (flaky/infra), report that it left the code alone. Mirrors Cascade's
 * respond-to-ci agent. Deciding *which* event triggers this (a `check_suite`
 * `completed` whose aggregate state shows a failed check, on a same-repo PR) is
 * the `pr-review` trigger handler's job (`src/triggers/handlers/review.ts`), not
 * this phase's: it receives a build to fix, already vetted, plus the per-PR
 * attempt cap that stops a never-sticking fix from looping.
 *
 * The checkout is the PR branch itself (`provision`'s `createBranch: false`
 * seam) — like Respond-to-review and unlike Review's detached throwaway, the
 * implementer commits and pushes here. That checkout target must already exist
 * as a *local* branch: `git worktree add <path> <branch>` doesn't DWIM
 * remote-only branches, so this phase leans on the Implementation phase having
 * created `issue-<n>` in the same `repoRoot` and its cleanup leaving the branch
 * behind (see `runImplementationPhase`'s re-run note). The local branch can be
 * *stale* — origin moves on the second CI-fix round or when a human co-pushes —
 * so the prompt's first step fast-forwards it; a diverged branch fails that sync
 * (and the job) rather than fixing code the failing CI never ran against.
 *
 * Same token plumbing as Implementation, for the same reason: the implementer
 * persona's token is resolved and handed to the agent as `GH_TOKEN` (mirroring
 * `runReviewPhase`'s reviewer-token plumbing) so every `gh` call — the PR
 * comment included — acts as that persona, not whatever `gh auth` session
 * happens to be ambient on the worker's host. (An earlier version of this
 * comment claimed the ambient credentials already *were* the implementer
 * persona; confirmed live on the Implementation phase that assumption was
 * false — see `runImplementationPhase`'s header.) No PM interaction: the item
 * already sits at "In review", and pushing a fix doesn't change board
 * status — the fresh check suite the fix triggers (→ Review on green, or another
 * CI-fix round on red) is what moves things next.
 *
 * This is the phase's orchestration only, same as the other phases. It composes
 * `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15) and
 * `runAgentCli` (SWARM-16), and takes the PR coordinates as inputs rather than
 * reaching for a queue or webhook payload.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getPersonaToken } from '@/config/provider.js';
import type { ProjectConfig } from '@/config/schema.js';
import { type AgentCli, type AgentCliResult, runAgentCli } from '@/harness/agent-cli.js';
import { logger } from '@/lib/logger.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the CI-fix agent is instructed to write its outcome to, at the worktree root. */
export const RESPOND_CI_OUTCOME_FILENAME = 'respond_ci_outcome.txt';

/**
 * The outcomes the agent may report. `fixed` means it pushed at least one fix
 * commit; `no-fix` means it investigated but changed no code — the failure was
 * flaky/infra or otherwise not something a code change should address. The agent
 * hands back which one applied via {@link RESPOND_CI_OUTCOME_FILENAME}; anything
 * else is a failed run, not a third outcome.
 */
export const RESPOND_CI_OUTCOMES = ['fixed', 'no-fix'] as const;

export type RespondCiOutcome = (typeof RESPOND_CI_OUTCOMES)[number];

/** Claude Code is SWARM's implementer agent — the persona that fixes the build. */
const DEFAULT_RESPOND_CI_CLI: AgentCli = 'claude';

/**
 * Cap on captured agent output, so a chatty/runaway fix run can't grow the
 * worker's memory without bound. The outcome is read from
 * {@link RESPOND_CI_OUTCOME_FILENAME}, not from stdout, so truncating the
 * captured stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunRespondToCiPhaseOptions {
	/** The SWARM project whose repo the PR belongs to. */
	project: ProjectConfig;
	/** The number of the PR whose check suite failed. */
	prNumber: string;
	/**
	 * The PR's head branch (`pull_request.head.ref`) — the existing task branch
	 * the worktree checks out and the agent pushes the fix to.
	 */
	prBranch: string;
	/**
	 * The head commit whose checks failed (`check_suite.head_sha`) — pins the
	 * agent to the exact commit CI ran against when it inspects the failing runs.
	 */
	headSha: string;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`). Passed explicitly
	 * rather than derived from `prNumber`: naming the task is the dequeuing
	 * worker's job, not this phase's. Today the review handler dispatches both
	 * Review and Respond-to-CI with `taskId: prNumber`, so both resolve to
	 * `task-<prNumber>`; a CI-fix and a still-running review of an earlier SHA on
	 * the same PR can therefore contend for one worktree path — the second
	 * `provision` throws "already exists" and that job fails cleanly (no retry
	 * storm) rather than the two clobbering each other. Distinct ids here would
	 * separate them, but that's the caller's choice to make.
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
	/** Injectable implementer-token resolver — defaults to {@link getPersonaToken}; overridden in tests. */
	getToken?: typeof getPersonaToken;
}

export interface RespondToCiPhaseResult {
	/** The outcome the agent reported, read from {@link RESPOND_CI_OUTCOME_FILENAME}. */
	outcome: RespondCiOutcome;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
}

/**
 * Build the prompt handed to the CI-fix agent. It's told it authored the PR and
 * its CI is failing: sync the branch first, inspect the failing checks (the
 * Actions logs for the pinned head SHA, not a guess), fix the build surgically
 * or report that no code change is warranted, verify locally before pushing,
 * comment on the PR, and record which outcome applied to
 * {@link RESPOND_CI_OUTCOME_FILENAME} so this phase can validate the hand-off.
 */
export function buildRespondToCiPrompt(context: {
	repo: string;
	prNumber: string;
	prBranch: string;
	headSha: string;
}): string {
	const { repo, prNumber, prBranch, headSha } = context;
	return [
		'You are a senior software engineer whose pull request has failing CI checks.',
		'',
		`This worktree has branch "${prBranch}" checked out — the head branch of PR`,
		`#${prNumber} in ${repo} on GitHub. Its check suite completed with at least one`,
		`failing check on commit ${headSha}.`,
		'',
		'Do all of the following, in order:',
		`1. Sync the branch with what CI ran: \`git pull --ff-only origin ${prBranch}\`. If this fails for any reason (diverged branch, deleted remote branch, network error), stop and exit non-zero rather than fixing stale code.`,
		`2. Find out what failed: \`gh pr checks ${prNumber} --repo ${repo}\` for the check summary, then read the failing run's logs — \`gh run view <run-id> --repo ${repo} --log-failed\` (list runs for the commit with \`gh run list --repo ${repo} --commit ${headSha}\`). Read the PR discussion for context too: \`gh pr view ${prNumber} --repo ${repo} --comments\`.`,
		'3. Diagnose the failure and fix it. Keep the fix surgical — change only what the failing checks require; do not refactor unrelated code. If the failure is not something a code change should address (a flaky test, transient infra, or a check unrelated to this PR), make NO code change.',
		`4. If you changed code: run the project lint, type-check, and the relevant tests locally and confirm they pass; fix whatever they surface. Then commit with a conventional-commit message and push: \`git push origin ${prBranch}\` (explicit remote/branch — the checkout may have no upstream configured, e.g. on a human-created PR branch).`,
		`5. Comment on the PR with exactly ONE comment, non-interactively: write it to a scratch file (e.g. respond_ci_body.md), then run \`gh pr comment ${prNumber} --repo ${repo} --body-file <file>\`. Say what was failing and either what you changed to fix it (name the commit) or why you made no change.`,
		`6. Write the outcome — exactly \`fixed\` if you pushed at least one fix commit, or exactly \`no-fix\` if you changed no code, and nothing else — to a file named "${RESPOND_CI_OUTCOME_FILENAME}" at the root of this worktree. Do NOT \`git add\`/commit this file (or the comment scratch file) — they are scratch hand-offs read by SWARM, not part of the PR.`,
		'',
		'Do not merge the PR, and do not review it — you are the author.',
	].join('\n');
}

/**
 * Log a failed CI-fix run's captured output before the phase throws, so the
 * worker that marks the job failed has the agent's own stdout/stderr to
 * diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, prNumber: string, agent: AgentCliResult): void {
	logger.error('respond-to-ci phase: agent failed', {
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
 * Run the Respond-to-CI phase for one failing check suite. Provisions a worktree
 * on the PR's existing branch, runs the implementer agent to fix the build —
 * pushing a fix or reporting that no change was warranted — and validates the
 * outcome it handed back.
 *
 * Throws if the agent exits non-zero (including the prompt's deliberate
 * diverged-branch bail-out) or if it produced no recognizable outcome — a fix
 * run that didn't verifiably answer the failure is a failed job, not a soft miss
 * (ai/CODING_STANDARDS.md "Error handling"). The worktree is always removed once
 * provisioned, success or failure; a pushed fix and the PR comment live on
 * GitHub and are unaffected.
 */
export async function runRespondToCiPhase(
	options: RunRespondToCiPhaseOptions,
): Promise<RespondToCiPhaseResult> {
	const {
		project,
		prNumber,
		prBranch,
		headSha,
		taskId,
		cli = DEFAULT_RESPOND_CI_CLI,
		model,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
		getToken = getPersonaToken,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	logger.info('respond-to-ci phase: start', { taskId, prNumber, prBranch, headSha, cli });

	// Resolved first: a missing implementer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	const implementerToken = await getToken(project, 'implementer');

	// The existing task branch, not a fresh one — the agent commits and pushes to
	// the PR here (see the module header for the local-branch precondition).
	const handle = await worktrees.provision(taskId, { createBranch: false, branch: prBranch });
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			model,
			cwd: handle.path,
			args: [buildRespondToCiPrompt({ repo: project.repo, prNumber, prBranch, headSha })],
			// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
			// call the agent makes (incl. the PR comment) acts as the implementer
			// persona, not the worker host's own logged-in account.
			env: { GH_TOKEN: implementerToken },
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-ci agent (${cli}) exited with code ${agent.exitCode}${
					agent.timedOut ? ' (timed out)' : ''
				} for PR #${prNumber}`,
			);
		}

		const outcomePath = join(handle.path, RESPOND_CI_OUTCOME_FILENAME);
		if (!existsSync(outcomePath)) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-ci agent (${cli}) did not write ${RESPOND_CI_OUTCOME_FILENAME} for PR #${prNumber}`,
			);
		}
		const rawOutcome = readFileSync(outcomePath, 'utf8').trim();
		if (rawOutcome.length === 0) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-ci agent (${cli}) wrote an empty ${RESPOND_CI_OUTCOME_FILENAME} for PR #${prNumber}`,
			);
		}
		// Case-tolerant ("Fixed" happens) but otherwise strict: an unknown outcome
		// means the hand-off contract broke, and pretending the fix happened would
		// stall the pipeline silently.
		const outcome = rawOutcome.toLowerCase() as RespondCiOutcome;
		if (!RESPOND_CI_OUTCOMES.includes(outcome)) {
			logAgentFailure(taskId, prNumber, agent);
			throw new Error(
				`Respond-to-ci agent (${cli}) wrote unrecognized outcome '${rawOutcome}' to ${RESPOND_CI_OUTCOME_FILENAME} for PR #${prNumber} (expected one of: ${RESPOND_CI_OUTCOMES.join(', ')})`,
			);
		}

		logger.info('respond-to-ci phase: done', { taskId, prNumber, prBranch, outcome });

		return { outcome, agent };
	} finally {
		// Swallow-and-log: a cleanup failure must not mask the run's outcome
		// (a successful phase turning into a reported failure, or a genuine
		// error being replaced by the cleanup error).
		try {
			await worktrees.cleanup(taskId);
		} catch (error) {
			logger.error('respond-to-ci phase: worktree cleanup failed', {
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
