/**
 * Respond-to-review phase (PROJECT.md §5.4, ai/ARCHITECTURE.md "Pipeline phases" #4).
 *
 * By default, the reviewer persona submits a `changes_requested` review and the
 * worker runs this: provision a worktree on the PR's existing task branch, spin
 * up Claude Code as the implementer to read the batched review, and for each
 * point either fix the code (Path A) or push back with a rationale (Path B).
 * `pipeline.respondToReview.skipOnMinors: false` can opt back into responding
 * to every reviewer verdict. "Wait for the final submitted review, not
 * individual line comments" is still Cascade's rule and still applies here.
 * Matching the event (`pull_request_review` `submitted`, authored by the
 * *reviewer* persona — the `getPersonaForLogin` routing in
 * `src/router/adapters/github.ts`) is the trigger handler's job (SWARM-53),
 * not this phase's: it receives a review to respond to, already vetted.
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
 * Same token plumbing as Implementation, for the same reason: the implementer
 * persona's token is resolved and handed to the agent as `GH_TOKEN` (mirroring
 * `runReviewPhase`'s reviewer-token plumbing) so every `gh` call — the PR
 * comment reply included — acts as that persona, not whatever `gh auth`
 * session happens to be ambient on the worker's host. (An earlier version of
 * this comment claimed the ambient credentials already *were* the implementer
 * persona; confirmed live on the Implementation phase that assumption was
 * false — see `runImplementationPhase`'s header.)
 *
 * Board status reports (Implementation's pattern, mirrored here): the item sits
 * at "In review" when this phase starts; it moves the card to "In progress"
 * while the implementer works and back to "In review" once it has responded, so
 * a human watching the board sees the response happening rather than a card that
 * looks idle for minutes. These are **status reports, not triggers** — neither
 * "In progress" nor "In review" starts a PM-driven phase (`src/pm/pipeline.ts`),
 * so bouncing the card between them can't re-fire Review or anything else (that
 * re-review is driven only by the *new commit* a fix pushes, deduped per head
 * SHA — `src/triggers/review-dispatch-dedup.ts`). And they are strictly
 * **best-effort**: the board item is resolved from the PR branch's issue number
 * (`<branchPrefix><n>`), and a failure to resolve it (a human-named branch, an
 * item not on the board) or to move it is logged and swallowed — a cosmetic
 * status report must never fail an otherwise-successful response. On a failed
 * run the card is left at "In progress" (as Implementation leaves it), with the
 * worker's failure comment explaining why; the next reviewer round moves it on.
 * Skipped entirely when no `pm` provider is injected (unit tests that don't
 * exercise the board).
 *
 * This is the phase's orchestration only, same as the other three. It composes
 * `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15) and
 * `runAgentCli` (SWARM-16), and takes the PR/review coordinates as inputs
 * rather than reaching for a queue or webhook payload.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { getPersonaToken } from '@/config/provider.js';
import type { ProjectConfig } from '@/config/schema.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { agentRunError } from '@/harness/agent-failure.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import { logger } from '@/lib/logger.js';
import { PIPELINE_PHASE_GUARD } from '@/pipeline/agent-scope.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider } from '@/pm/types.js';
import {
	commitPreparedTree,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	loadDeliveryProgress,
	ReviewResponseHandoffSchema,
	readHandoff,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the respond agent is instructed to write its outcome to, at the worktree root. */
export const RESPOND_OUTCOME_FILENAME = HANDOFF_FILENAMES.respondToReview;

/**
 * Status the card moves to while the implementer responds — the board's "In
 * progress". A status *report* (a human watching sees the response happening),
 * never a trigger: entering "In progress" starts no PM-driven phase
 * (`src/pm/pipeline.ts`). Typed to {@link PmStatusKey} so a typo fails to
 * compile rather than silently addressing a status the adapter can't resolve.
 */
const PICKUP_STATUS: PmStatusKey = 'inProgress';

/**
 * Status the card returns to once the response is posted — back to the board's
 * "In review" it started at. Also a report, not a trigger (`src/pm/pipeline.ts`),
 * so returning here can't re-fire Review; only a *new commit* does, deduped per
 * head SHA (`src/triggers/review-dispatch-dedup.ts`).
 */
const DONE_STATUS: PmStatusKey = 'inReview';

/**
 * The outcomes the agent may report — PROJECT.md §5.4's two paths, now also
 * covering an approval/comment review with nothing actionable in it. `fixed`
 * means at least one fix commit was pushed (even if some points were pushed
 * back); `pushed-back` means no code changed because at least one concrete
 * point was rejected with a rationale; `no-findings` means the review raised
 * no actionable points and the agent only acknowledged it. The agent hands
 * back which one applied via
 * {@link RESPOND_OUTCOME_FILENAME}; anything else is a failed run, not a third
 * outcome.
 */
export const RESPOND_OUTCOMES = ['fixed', 'pushed-back', 'no-findings'] as const;

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
	 * worktree for the same change — the trigger handler dispatches this as
	 * `` `${prNumber}-respond` ``, not the bare PR number Review's own `taskId`
	 * uses, for exactly that reason (see git history for the incident this fixed).
	 */
	taskId: string;
	/**
	 * PM provider for the project's board, used purely for best-effort status
	 * reports (→ In progress while responding, → In review when done). Provider-
	 * agnostic — this phase only ever calls the {@link PMProvider} interface, so a
	 * future Jira/Linear/Trello provider drops in with no change here. Omitted in
	 * unit tests that don't exercise the board (board reports are then skipped).
	 */
	pm?: PMProvider;
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
	/** Injectable GitHub auto-merge operation; best-effort after an eligible response when enabled. */
	enablePullRequestAutoMerge?: (
		project: ProjectConfig,
		prNumber: number,
	) => Promise<{ enabled: boolean; message: string }>;
}

export interface RespondToReviewPhaseResult {
	/** The outcome the agent reported, read from {@link RESPOND_OUTCOME_FILENAME}. */
	outcome: RespondOutcome;
	/**
	 * The canonical status the card was moved back to on success ({@link DONE_STATUS}),
	 * or `undefined` when no board report happened — no `pm` injected, the board
	 * item couldn't be resolved, or the move failed (all best-effort).
	 */
	movedTo?: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
	/** Whether GitHub accepted the opt-in automatic-merge request. */
	autoMergeEnabled?: boolean;
}

/**
 * The backing issue number encoded in a SWARM task branch (`<branchPrefix><n>`,
 * e.g. `issue-100` or `issue-100-runs-list` → `100`), or `undefined` when the
 * branch doesn't follow the convention (a human-named PR branch). Used only to
 * resolve the board card for a best-effort status report, so a miss is fine.
 */
export function issueNumberFromBranch(branch: string, branchPrefix: string): string | undefined {
	if (!branch.startsWith(branchPrefix)) return undefined;
	const match = branch.slice(branchPrefix.length).match(/^(\d+)/);
	return match ? match[1] : undefined;
}

/**
 * Resolve the board item wrapping issue `#{issueNumber}` to its provider-native
 * ID, or `undefined` if it isn't on the board. Provider-agnostic: matches on the
 * work item's backing `url` (which every {@link PMProvider} populates) rather
 * than anything GitHub-specific. Swallows and logs provider errors — the caller
 * treats any failure as "no board report", never a phase failure.
 */
async function resolveBoardItemId(
	pm: PMProvider,
	issueNumber: string,
	taskId: string,
): Promise<string | undefined> {
	try {
		const items = await pm.listWorkItems();
		// `endsWith('/issues/100')` can't false-match `/issues/1001` — the char
		// before `100` must be `/` — so no need to anchor on the repo too.
		const match = items.find((item) => item.url.endsWith(`/issues/${issueNumber}`));
		if (!match) {
			logger.debug('respond-to-review: no board item found for issue — skipping status report', {
				taskId,
				issueNumber,
			});
			return undefined;
		}
		return match.id;
	} catch (error) {
		logger.warn('respond-to-review: could not resolve board item — skipping status report', {
			taskId,
			issueNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Best-effort board status report. Moves the item and returns whether it
 * succeeded; a provider error is logged and swallowed (returns `false`) so a
 * cosmetic report can never fail the response — see the module header.
 */
async function reportBoardStatus(
	pm: PMProvider,
	itemId: string,
	status: PmStatusKey,
	taskId: string,
): Promise<boolean> {
	try {
		await pm.moveWorkItem(itemId, status);
		return true;
	} catch (error) {
		logger.warn('respond-to-review: board status report failed — continuing', {
			taskId,
			status,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * Build the prompt handed to the respond agent. It's told it authored the PR
 * and is answering its reviewer: sync the branch first, read the pinned review
 * (summary body plus its batched line comments — the review API, not the issue
 * comment stream), address every point — including minor/nit suggestions, not
 * just blocking ones — as either a fix or a reasoned push-back, verify fixes
 * before pushing, ALWAYS reply on the PR (a point-by-point answer if the
 * review raised anything, otherwise a short thank-you so a human can see the
 * response ran), and record which outcome applied to
 * {@link RESPOND_OUTCOME_FILENAME} so this phase can validate the hand-off.
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
		...PIPELINE_PHASE_GUARD,
		'',
		`This worktree has branch "${prBranch}" checked out — the head branch of PR`,
		`#${prNumber} in ${repo} on GitHub. A reviewer has submitted a review — it may`,
		'request changes, just comment, or approve with suggestions attached. Respond to it',
		'regardless of verdict: an approval is not a reason to stay silent.',
		'',
		'Do all of the following, in order:',
		`1. Sync the branch with what the reviewer saw: \`git pull --ff-only origin ${prBranch}\`. If this fails for any reason (diverged branch, deleted remote branch, network error), stop and exit non-zero rather than responding against stale code.`,
		`2. Read the submitted review you are responding to: \`gh api repos/${repo}/pulls/${prNumber}/reviews/${reviewId}\` for its summary body, and \`gh api repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments\` for its line comments. Read the PR discussion for context too: \`gh pr view ${prNumber} --repo ${repo} --comments\`.`,
		'3. Address EVERY point the review raises — including minor/nit suggestions, not',
		'   just blocking "changes requested" items; a valid nit is worth fixing even on an',
		'   approval. For each point, either:',
		'   - fix the code (keep the fix surgical — only go broader when the reviewer clearly asks for it), or',
		'   - if the point is mistaken, push back: no code change, but a clear rationale in your reply below.',
		'   If the review raised no specific points at all (e.g. a plain approval with',
		'   nothing to fix or question), skip straight to step 5.',
		'4. If you changed code, run lint, type-check, and relevant tests. Do not commit, push, comment, or perform any GitHub mutation.',
		`Do not run \`git push origin ${prBranch}\` or \`gh pr comment ${prNumber} --repo ${repo}\`; GH_TOKEN is not assigned for delivery and you must not run gh auth switch. Do NOT \`git add\`/commit the hand-off.`,
		`5. Write "${RESPOND_OUTCOME_FILENAME}" as JSON with outcome (fixed, pushed-back, or no-findings), body (the point-by-point PR reply), optional commitSubject when fixed, and verification [{command,outcome:"passed"}].`,
		'The outcome strings are exactly `fixed`, `pushed-back`, and `no-findings`. The body must ALWAYS reply on the PR point by point; with no findings, post a short comment thanking the reviewer — never skip this step, even when there is nothing to fix.',
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
	logger.error('Phase failed - Respond-to-review — agent output', {
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

async function enableAutoMerge(
	enabled: boolean,
	outcome: RespondOutcome,
	enablePullRequestAutoMerge: NonNullable<
		RunRespondToReviewPhaseOptions['enablePullRequestAutoMerge']
	>,
	project: ProjectConfig,
	prNumber: string,
	taskId: string,
): Promise<boolean | undefined> {
	// A pushback leaves requested changes unresolved. Only a real fix or a
	// no-findings acknowledgment is safe to hand to GitHub for auto-merge.
	if (!enabled || (outcome !== 'fixed' && outcome !== 'no-findings')) return undefined;
	try {
		const merge = await enablePullRequestAutoMerge(project, Number(prNumber));
		if (merge.enabled) {
			logger.info('Respond-to-review enabled GitHub auto-merge for pull request', {
				taskId,
				prNumber,
			});
		} else {
			logger.warn('Respond-to-review did not enable GitHub auto-merge', {
				taskId,
				prNumber,
				reason: merge.message,
			});
		}
		return merge.enabled;
	} catch (error) {
		logger.warn(
			'Respond-to-review could not enable GitHub auto-merge — response remains successful',
			{
				taskId,
				prNumber,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return false;
	}
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
		pm,
		cli = DEFAULT_RESPOND_CLI,
		model,
		sessionId,
		resumeSessionId,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
		enablePullRequestAutoMerge = (mergeProject, mergePrNumber) =>
			new GitHubSCMIntegration().enablePullRequestAutoMerge(mergeProject, mergePrNumber),
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const legacyToken = options.getToken ? await options.getToken(project, 'implementer') : undefined;

	logger.info(`Phase started - Respond-to-review — running ${describeAgent(cli, model)}`, {
		taskId,
		prNumber,
		prBranch,
		reviewId,
		cli,
		model,
	});

	// Resolved first: a missing implementer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	// Best-effort board report: resolve the card once (reused for the closing
	// move) and reflect "In progress" before the (possibly long) agent run, so a
	// human watching the board sees the response start — never blocks or fails the
	// response. See the module header. Skipped when no provider is injected.
	const issueNumber = issueNumberFromBranch(prBranch, project.branchPrefix);
	const boardItemId =
		pm && issueNumber ? await resolveBoardItemId(pm, issueNumber, taskId) : undefined;
	if (pm && boardItemId) {
		await reportBoardStatus(pm, boardItemId, PICKUP_STATUS, taskId);
	}

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

		const agent = await runAgent({
			cli,
			model,
			...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
			cwd: handle.path,
			args: [buildRespondToReviewPrompt({ repo: project.repo, prNumber, prBranch, reviewId })],
			// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
			// call the agent makes (incl. the PR comment reply) acts as the
			// implementer persona, not the worker host's own logged-in account.
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			logContext: { taskId, phase: 'respond-to-review', prNumber, prBranch },
			timeoutMs,
			signal,
			...(legacyToken ? { env: { GH_TOKEN: legacyToken } } : {}),
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			const error = agentRunError(
				agent,
				`Respond-to-review agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		// Case-tolerant ("Fixed" happens) but otherwise strict: an unknown outcome
		// means the hand-off contract broke, and pretending the response happened
		// would stall the pipeline silently.
		if (legacyToken) {
			if (!existsSync(join(handle.path, RESPOND_OUTCOME_FILENAME)))
				throw new Error(
					`Respond-to-review agent (${cli}) did not write ${RESPOND_OUTCOME_FILENAME}`,
				);
			const outcome = readFileSync(join(handle.path, RESPOND_OUTCOME_FILENAME), 'utf8')
				.trim()
				.toLowerCase() as RespondOutcome;
			if (!outcome)
				throw new Error(
					`Respond-to-review agent (${cli}) wrote an empty ${RESPOND_OUTCOME_FILENAME}`,
				);
			if (!RESPOND_OUTCOMES.includes(outcome))
				throw new Error(`Respond-to-review agent (${cli}) wrote unrecognized outcome '${outcome}'`);
			let movedTo: PmStatusKey | undefined;
			if (pm && boardItemId && (await reportBoardStatus(pm, boardItemId, DONE_STATUS, taskId)))
				movedTo = DONE_STATUS;
			const autoMergeEnabled = await enableAutoMerge(
				project.pipeline?.respondToReview?.autoMerge ?? false,
				outcome,
				enablePullRequestAutoMerge,
				project,
				prNumber,
				taskId,
			);
			return { outcome, movedTo, agent, autoMergeEnabled };
		}
		const handoff = readHandoff(handle.path, RESPOND_OUTCOME_FILENAME, ReviewResponseHandoffSchema);
		if (
			handoff.outcome === 'fixed' &&
			(!handoff.commitSubject || (handoff.verification?.length ?? 0) === 0)
		) {
			throw new Error(
				'Invalid respond-to-review hand-off: fixed requires commitSubject and verification',
			);
		}
		const delivery =
			options.delivery ??
			(await new GitHubSCMIntegration().deliveryProvider(project, 'implementer'));
		const deliveryId = deliveryIdentity(['respond-to-review', project.repo, prNumber, reviewId]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		if (handoff.outcome === 'fixed' && !progress.commitSha) {
			progress.commitSha = await commitPreparedTree(handle.path, handoff.commitSubject as string);
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

		// Best-effort: return the card to "In review" now the response is posted.
		// Only on success — a failed run leaves it at "In progress" (as
		// Implementation does), with the worker's failure comment explaining why.
		let movedTo: PmStatusKey | undefined;
		if (pm && boardItemId && (await reportBoardStatus(pm, boardItemId, DONE_STATUS, taskId))) {
			movedTo = DONE_STATUS;
		}

		const autoMergeEnabled = await enableAutoMerge(
			project.pipeline?.respondToReview?.autoMerge ?? false,
			outcome,
			enablePullRequestAutoMerge,
			project,
			prNumber,
			taskId,
		);

		logger.info('Phase finished - Respond-to-review', {
			taskId,
			prNumber,
			prBranch,
			outcome,
			movedTo,
			autoMergeEnabled,
		});

		return { outcome, movedTo, agent, autoMergeEnabled };
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'respond-to-review phase');
	}
}
