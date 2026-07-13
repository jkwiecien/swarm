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
import { nativeDelegationEnabled } from '@/delegation/native.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { agentRunError } from '@/harness/agent-failure.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import { logger } from '@/lib/logger.js';
import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import {
	CiResponseHandoffSchema,
	commitPreparedTree,
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	loadDeliveryProgress,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the CI-fix agent is instructed to write its outcome to, at the worktree root. */
export const RESPOND_CI_OUTCOME_FILENAME = HANDOFF_FILENAMES.respondToCi;

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
	 * worker's job, not this phase's. The review handler dispatches this as
	 * `` `${prNumber}-ci` ``, distinct from Review's own `taskId: prNumber` —
	 * a CI-fix and a still-running review of an earlier SHA on the same PR must
	 * not contend for one worktree path (they did, before that suffix was
	 * added; see git history).
	 */
	taskId: string;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Claude Code. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/**
	 * Session id to assign to a fresh run (`sessionId`) or resume from on a retry
	 * (`resumeSessionId`). When resuming, the preserved PR-branch checkout is
	 * reused so the agent continues its prior session (and any partial fixes) in place.
	 */
	sessionId?: string;
	resumeSessionId?: string;
	/** Kill the agent run after this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the agent run. */
	signal?: AbortSignal;
	/** Injectable agent runner — defaults to {@link runAgentCli}; overridden in tests. */
	runAgent?: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	/** Injectable env-grafting step — defaults to {@link graftEnvironment}; overridden in tests. */
	graft?: typeof graftEnvironment;
	/** Injectable implementer-token resolver — defaults to {@link getPersonaToken}; overridden in tests. */
	delivery?: ScmDeliveryProvider;
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
export function buildRespondToCiPrompt(
	context: {
		repo: string;
		prNumber: string;
		prBranch: string;
		headSha: string;
	},
	nativeDelegation = false,
): string {
	const { repo, prNumber, prBranch, headSha } = context;
	return [
		'You are a senior software engineer whose pull request has failing CI checks.',
		'',
		...pipelinePhaseGuard(nativeDelegation),
		...GH_IDENTITY_GUARD,
		'',
		`This worktree has branch "${prBranch}" checked out — the head branch of PR`,
		`#${prNumber} in ${repo} on GitHub. Its check suite completed with at least one`,
		`failing check on commit ${headSha}.`,
		'',
		'Do all of the following, in order:',
		`1. Sync the branch with what CI ran: \`git pull --ff-only origin ${prBranch}\`. If this fails for any reason (diverged branch, deleted remote branch, network error), stop and exit non-zero rather than fixing stale code.`,
		`2. Find out what failed: \`gh pr checks ${prNumber} --repo ${repo}\` for the check summary, then read the failing run's logs — \`gh run view <run-id> --repo ${repo} --log-failed\` (list runs for the commit with \`gh run list --repo ${repo} --commit ${headSha}\`). Read the PR discussion for context too: \`gh pr view ${prNumber} --repo ${repo} --comments\`.`,
		'3. Diagnose the failure and fix it. Keep the fix surgical — change only what the failing checks require; do not refactor unrelated code. If the failure is not something a code change should address (a flaky test, transient infra, or a check unrelated to this PR), make NO code change.',
		'4. If you changed code, run lint, type-check, and relevant tests. Do not commit, push, comment, or perform any GitHub mutation.',
		`Do not run \`git push origin ${prBranch}\` or \`gh pr comment ${prNumber} --repo ${repo}\`; GH_TOKEN is read-only context authentication and you must not run gh auth switch. Do NOT \`git add\`/commit the hand-off.`,
		`5. Write "${RESPOND_CI_OUTCOME_FILENAME}" as JSON containing outcome (fixed or no-fix), body (the PR explanation), optional commitSubject when fixed, and verification [{command,outcome:"passed"}].`,
		'The outcome strings are exactly `fixed` and `no-fix`.',
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
	logger.error('Phase failed - Respond-to-CI — agent output', {
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
		sessionId,
		resumeSessionId,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const legacyMode = options.getToken !== undefined && options.delivery === undefined;
	const agentToken = await (options.getToken ?? getPersonaToken)(project, 'implementer');

	logger.info(`Phase started - Respond-to-CI — running ${describeAgent(cli, model)}`, {
		taskId,
		prNumber,
		prBranch,
		headSha,
		cli,
		model,
	});

	// Resolved first: a missing implementer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	// The existing task branch, not a fresh one — the agent commits and pushes to
	// the PR here (see the module header for the local-branch precondition). On a
	// resume retry, reuse the preserved checkout so partial fixes and the agent's
	// session carry over.
	const { handle, resumed } = await acquireResumableWorktree(
		worktrees,
		taskId,
		prBranch,
		false,
		resumeSessionId,
		() => worktrees.provision(taskId, { createBranch: false, branch: prBranch }),
	);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		const resumeDelivery = !legacyMode && hasDeliveryProgress(handle.path);
		const agent = resumeDelivery
			? resumedDeliveryAgent(cli)
			: await runAgent({
					cli,
					model,
					...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
					cwd: handle.path,
					args: [
						buildRespondToCiPrompt(
							{ repo: project.repo, prNumber, prBranch, headSha },
							nativeDelegationEnabled(project, 'respond-to-ci', cli),
						),
					],
					// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
					// call the agent makes (incl. the PR comment) acts as the implementer
					// persona, not the worker host's own logged-in account.
					maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
					logContext: { taskId, phase: 'respond-to-ci', prNumber, headSha },
					timeoutMs,
					signal,
					env: { GH_TOKEN: agentToken },
				});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			const error = agentRunError(
				agent,
				`Respond-to-ci agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		if (legacyMode) {
			if (!existsSync(join(handle.path, RESPOND_CI_OUTCOME_FILENAME)))
				throw new Error(
					`Respond-to-ci agent (${cli}) did not write ${RESPOND_CI_OUTCOME_FILENAME}`,
				);
			const outcome = readFileSync(join(handle.path, RESPOND_CI_OUTCOME_FILENAME), 'utf8')
				.trim()
				.toLowerCase() as RespondCiOutcome;
			if (!outcome)
				throw new Error(
					`Respond-to-ci agent (${cli}) wrote an empty ${RESPOND_CI_OUTCOME_FILENAME}`,
				);
			if (!RESPOND_CI_OUTCOMES.includes(outcome))
				throw new Error(`Respond-to-ci agent (${cli}) wrote unrecognized outcome '${outcome}'`);
			return { outcome, agent };
		}
		const handoff = readHandoff(handle.path, RESPOND_CI_OUTCOME_FILENAME, CiResponseHandoffSchema);
		if (
			handoff.outcome === 'fixed' &&
			(!handoff.commitSubject || (handoff.verification?.length ?? 0) === 0)
		) {
			throw new Error(
				'Invalid respond-to-CI hand-off: fixed requires commitSubject and verification',
			);
		}
		const delivery =
			options.delivery ??
			(await new GitHubSCMIntegration().deliveryProvider(project, 'implementer'));
		const deliveryId = deliveryIdentity(['respond-to-ci', project.repo, prNumber, headSha]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (handoff.outcome === 'fixed' && !progress.commitSha) {
			progress.commitSha = await commitPreparedTree(
				handle.path,
				handoff.commitSubject as string,
				delivery.commitIdentity,
			);
			saveDeliveryProgress(handle.path, progress);
		}
		if (progress.commitSha && !progress.pushed) {
			await delivery.pushBranch(handle.path, prBranch, progress.commitSha);
			progress.pushed = true;
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.commentId) {
			progress.commentId = await delivery.postComment({
				prNumber: Number(prNumber),
				body: handoff.body,
				deliveryId,
			});
			saveDeliveryProgress(handle.path, progress);
		}
		const outcome = handoff.outcome;

		logger.info('Phase finished - Respond-to-CI', { taskId, prNumber, prBranch, outcome });

		return { outcome, agent };
	} catch (error) {
		if (!legacyMode && hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('CI-response delivery deferred for retry', { cause: error });
		}
		throw error;
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'respond-to-ci phase');
	}
}
