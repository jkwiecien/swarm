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

import { getPersonaToken } from '@/config/provider.js';
import type { ProjectConfig } from '@/config/schema.js';
import { delegationEnabled } from '@/delegation/native.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { agentRunError } from '@/harness/agent-failure.js';
import type { ReasoningLevel } from '@/harness/models.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import { logger } from '@/lib/logger.js';
import {
	type EnablePullRequestAutoMerge,
	enableAutoMergeIfEligible,
	enablePullRequestAutoMergeDefault,
} from '@/pipeline/auto-merge.js';
import { buildReviewPrompt } from '@/pipeline/prompts/review.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import {
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	loadDeliveryProgress,
	ReviewHandoffSchema,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the review agent is instructed to write its submitted verdict to, at the worktree root. */
export const REVIEW_VERDICT_FILENAME = HANDOFF_FILENAMES.review;

// The static review prompt now lives in `src/pipeline/prompts/review.ts` (issue
// #135); re-exported so existing importers of `@/pipeline/review.js` keep
// resolving it unchanged.
export { buildReviewPrompt };

/**
 * The verdicts the agent may submit — `gh pr review`'s three event flags. The
 * agent hands back which one it used via {@link REVIEW_VERDICT_FILENAME};
 * anything else is a failed run, not a fourth outcome.
 */
export const REVIEW_VERDICTS = ['approve', 'request-changes', 'comment'] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Claude Code is SWARM's review agent (PROJECT.md §5.3) — run as the reviewer persona. */
export const DEFAULT_REVIEW_CLI: AgentCli = 'claude';

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
	/** Reasoning level for the agent's session. Omit for the CLI/model default (issue #180). */
	reasoning?: ReasoningLevel;
	/**
	 * Project's optional custom prompt for this phase (`agents.review.prompt`,
	 * issue #135) — appended to the static SWARM prompt as a supplement-only
	 * section. Omit for today's prompt exactly.
	 */
	customPrompt?: string;
	/**
	 * Session id to assign to a fresh run (`sessionId`) or resume from on a retry
	 * (`resumeSessionId`). When resuming, the preserved head-SHA checkout is reused
	 * so the agent continues its prior session in place.
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
	/** Injectable reviewer-token resolver — defaults to {@link getPersonaToken}; overridden in tests. */
	delivery?: ScmDeliveryProvider;
	/** @deprecated Compatibility seam for pre-delivery tests; production leaves this unset. */
	getToken?: typeof getPersonaToken;
	/**
	 * Injectable GitHub auto-merge operation; best-effort after an `approve`
	 * verdict when `pipeline.respondToReview.autoMerge` is on (issue #231).
	 */
	enablePullRequestAutoMerge?: EnablePullRequestAutoMerge;
}

export interface ReviewPhaseResult {
	/** The verdict the agent submitted, read from {@link REVIEW_VERDICT_FILENAME}. */
	verdict: ReviewVerdict;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
	/**
	 * Whether GitHub accepted the opt-in automatic-merge request after an
	 * approval; `undefined` when auto-merge is disabled or the verdict wasn't an
	 * approval, so the provider was never asked.
	 */
	autoMergeEnabled?: boolean;
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
		reasoning,
		customPrompt,
		sessionId,
		resumeSessionId,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
		enablePullRequestAutoMerge = enablePullRequestAutoMergeDefault,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const legacyMode = options.getToken !== undefined && options.delivery === undefined;
	const agentToken = await (options.getToken ?? getPersonaToken)(project, 'reviewer');

	// Once the review is submitted, an `approve` is the point at which SWARM's
	// review is satisfied — so when the project opts in, arm GitHub auto-merge
	// here (issue #231). A normal `approve` skips Respond-to-review, so this is
	// the only phase that can act on it; the same setting still covers
	// Respond-to-review's `fixed`/`no-findings` outcomes. Best-effort: a refusal
	// or error is logged and never fails the completed review.
	const armAutoMerge = (verdict: ReviewVerdict): Promise<boolean | undefined> =>
		enableAutoMergeIfEligible({
			enabled: project.pipeline?.respondToReview?.autoMerge ?? false,
			eligible: verdict === 'approve',
			enablePullRequestAutoMerge,
			project,
			prNumber,
			taskId,
			phase: 'Review',
		});

	logger.info(`Phase started - Review — running ${describeAgent(cli, model, reasoning)}`, {
		taskId,
		prNumber,
		headSha,
		cli,
		model,
		reasoning,
	});

	// Resolved first: a missing reviewer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	// Read-only checkout pinned to the reviewed commit (see the module header for
	// why detached-at-SHA rather than the PR branch). On a resume retry, reuse the
	// preserved checkout so the agent continues its session against the same head.
	const { handle, resumed } = await acquireResumableWorktree(
		worktrees,
		taskId,
		headSha,
		true,
		resumeSessionId,
		() => worktrees.provision(taskId, { detach: true, baseBranch: headSha }),
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
					reasoning,
					...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
					cwd: handle.path,
					args: [
						buildReviewPrompt(
							{ repo: project.repo, prNumber, headSha },
							delegationEnabled(project, 'review', cli),
							customPrompt,
						),
					],
					// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
					// call the agent makes acts as the reviewer persona.
					maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
					logContext: { taskId, phase: 'review', prNumber, headSha },
					timeoutMs,
					signal,
					env: { GH_TOKEN: agentToken },
				});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			const error = agentRunError(
				agent,
				`Review agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		if (legacyMode) {
			if (!existsSync(join(handle.path, REVIEW_VERDICT_FILENAME)))
				throw new Error(`Review agent (${cli}) did not write ${REVIEW_VERDICT_FILENAME}`);
			const original = readFileSync(join(handle.path, REVIEW_VERDICT_FILENAME), 'utf8').trim();
			const raw = original.toLowerCase() as ReviewVerdict;
			if (!raw) throw new Error(`Review agent (${cli}) wrote an empty ${REVIEW_VERDICT_FILENAME}`);
			if (!REVIEW_VERDICTS.includes(raw))
				throw new Error(`Review agent (${cli}) wrote unrecognized verdict '${original}'`);
			const autoMergeEnabled = await armAutoMerge(raw);
			return { verdict: raw, agent, autoMergeEnabled };
		}
		const handoff = readHandoff(handle.path, REVIEW_VERDICT_FILENAME, ReviewHandoffSchema);
		const delivery =
			options.delivery ?? (await new GitHubSCMIntegration().deliveryProvider(project, 'reviewer'));
		const deliveryId = deliveryIdentity(['review', project.repo, prNumber, headSha]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (!progress.reviewId)
			progress.reviewId = await delivery.submitReview({
				prNumber: Number(prNumber),
				verdict: handoff.verdict,
				body: handoff.body,
				deliveryId,
			});
		saveDeliveryProgress(handle.path, progress);
		const verdict = handoff.verdict;
		const autoMergeEnabled = await armAutoMerge(verdict);

		logger.info('Phase finished - Review', {
			taskId,
			prNumber,
			headSha,
			verdict,
			autoMergeEnabled,
		});

		return { verdict, agent, autoMergeEnabled };
	} catch (error) {
		if (!legacyMode && hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('Review delivery deferred for retry', { cause: error });
		}
		throw error;
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'review phase');
	}
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
