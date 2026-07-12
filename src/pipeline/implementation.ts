/**
 * Implementation phase (PROJECT.md §5.2, ai/ARCHITECTURE.md "Pipeline phases" #2).
 *
 * An item moves to "ToDo" on the board → the worker runs this: move the item to
 * "In progress" to report that the agent has picked up the task (a status
 * report, not a trigger — see `src/pm/pipeline.ts`; this move is unconditional),
 * provision a worktree on the task branch (not detached — unlike Planning, this
 * phase commits and pushes), graft the environment, spin up Claude Code as the
 * implementer to implement the plan / run tests / commit / push / open a PR,
 * post the PR link back on the item, and — if `autoAdvance` (default `true`) —
 * move it to "In review".
 *
 * Unlike Cascade — whose implementer opens the PR through a `CreatePR` gadget
 * exposed to the agent — SWARM's harness is deliberately narrow (`runAgentCli`
 * only spawns the CLI, no gadget layer; see ai/ARCHITECTURE.md "Harness"). So the
 * agent opens the PR itself via `gh` (the same way the `/solve-issue` skill does)
 * and hands the URL back through a file, mirroring how the Planning phase reads
 * `proposed_plan.md`. The `Closes #<n>` in the PR body is what links the PR back
 * to the Issue the Projects item wraps; the comment this phase posts is the
 * human-facing pointer.
 *
 * The implementer persona's token is resolved and handed to the agent as
 * `GH_TOKEN` (mirroring `runReviewPhase`'s reviewer-token plumbing) so `gh pr
 * create` opens the PR as that persona, not whatever `gh auth` session happens
 * to be ambient on the worker's host. Confirmed live: without this, the PR
 * came back authored by the developer's own account, which the author-persona
 * gate (`ai/ARCHITECTURE.md`, `src/triggers/handlers/review.ts`) correctly
 * refuses to review — "not a SWARM persona" — silently stranding the item in
 * "In review" forever with nothing to trigger Review, let alone
 * Respond-to-review after it.
 *
 * This is the phase's orchestration only. It composes the building blocks that
 * already exist — `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15),
 * `runAgentCli` (SWARM-16), the `PMProvider` contract (SWARM-11) — and takes them
 * (plus the work item) as inputs rather than reaching for a queue or a concrete
 * GraphQL provider. The BullMQ consumer that dequeues a `TASK_TYPE_IMPLEMENTATION`
 * job and calls this, and the concrete GitHub Projects `PMProvider` adapter, are
 * their own issues (SWARM-17 and the PM-adapter issue); this lands ahead of them
 * the same way Planning did, wired up when they arrive.
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
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import { logger } from '@/lib/logger.js';
import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { PIPELINE_PHASE_GUARD } from '@/pipeline/agent-scope.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import {
	commitPreparedTree,
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	ImplementationHandoffSchema,
	loadDeliveryProgress,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager, type WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the implementation agent is instructed to write the opened PR's URL to, at the worktree root. */
export const OPENED_PR_FILENAME = HANDOFF_FILENAMES.implementation;

/** A concise, agent-written explanation when implementation is blocked by a prerequisite. */
export const BLOCKED_REASON_FILENAME = 'blocked_reason.md';

/** Claude Code is SWARM's implementer agent (PROJECT.md §5.2). */
const DEFAULT_IMPLEMENTATION_CLI: AgentCli = 'claude';

/**
 * Status the item moves to as soon as this phase starts, before the agent even
 * runs — reports to a human watching the board that the task has been picked
 * up. Not a trigger: entering "In progress" doesn't itself start anything
 * (`src/pm/pipeline.ts`), only the item entering "ToDo" does.
 */
const START_STATUS: PmStatusKey = 'inProgress';

/**
 * Status the item moves to once the PR is opened, when `autoAdvance` is on —
 * the board's "In review". Typed to {@link PmStatusKey} so a typo fails to
 * compile rather than silently sending the item to a status the adapter can't
 * resolve. This status isn't a PM-driven phase entry point
 * (`src/pm/pipeline.ts`), so moving here can't loop back into implementation.
 */
const NEXT_STATUS: PmStatusKey = 'inReview';

/** `autoAdvance` default when `project.pipeline.implementation.autoAdvance` is unset. */
const DEFAULT_AUTO_ADVANCE = true;

/**
 * Cap on captured agent output, so a chatty/runaway Claude Code run can't grow the
 * worker's memory without bound. The PR URL is read from {@link OPENED_PR_FILENAME},
 * not from stdout, so truncating the captured stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunImplementationPhaseOptions {
	/** The SWARM project whose board the item lives on. */
	project: ProjectConfig;
	/**
	 * The Projects item that entered "ToDo". Its `id` addresses the item
	 * for the PM provider; its `url`/`title`/`description` describe the work.
	 */
	workItem: WorkItem;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`) and branch name
	 * (`<branchPrefix><taskId>`) — the linked issue number. Also the `#<n>` the PR
	 * body closes, which is what links the PR to the item. Passed explicitly rather
	 * than derived from `workItem`: the item's `id` is an opaque node ID, and the
	 * worker that dequeues the job is the layer that knows the issue number.
	 */
	taskId: string;
	/** PM provider used to post the PR-link comment and move the item's status. */
	pm: PMProvider;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Claude Code. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/** Deterministic Claude session handle assigned by the run row. */
	sessionId?: string;
	/** Resume this Claude session when its preserved worktree still exists. */
	resumeSessionId?: string;
	/**
	 * Whether to move the item to "In review" once the PR is opened. Defaults
	 * to `true`. The pickup move to "In progress" at the start of this phase is
	 * unconditional either way — this only governs the end-of-phase move.
	 */
	autoAdvance?: boolean;
	/** Resume a deferred implementation from its existing task branch. */
	resumeExistingBranch?: boolean;
	/** Kill the agent run after this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the agent run. */
	signal?: AbortSignal;
	/** Injectable agent runner — defaults to {@link runAgentCli}; overridden in tests. */
	runAgent?: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	/** Injectable env-grafting step — defaults to {@link graftEnvironment}; overridden in tests. */
	graft?: typeof graftEnvironment;
	/** Provider-neutral deterministic SCM delivery seam. */
	delivery?: ScmDeliveryProvider;
	/** @deprecated Compatibility seam; production deterministic delivery leaves this unset. */
	getToken?: typeof getPersonaToken;
}

export interface ImplementationPhaseResult {
	/** The URL of the PR the agent opened, read from {@link OPENED_PR_FILENAME}. */
	prUrl: string;
	/** The branch the implementation was committed to and the PR opened from. */
	branch: string;
	/** ID of the comment the PR link was posted as. */
	commentId: string;
	/** The canonical status the item was moved to, or `undefined` when `autoAdvance` was off. */
	movedTo?: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
}

/**
 * Build the prompt handed to the implementation agent. It's told to implement the
 * work item (following the plan the Planning phase posted on the linked Issue),
 * verify with lint/typecheck/tests, commit, push the task branch, open a PR
 * against the base branch whose body closes the issue, and finally record the
 * opened PR's URL to {@link OPENED_PR_FILENAME} so this phase can link it back.
 */
export function buildImplementationPrompt(
	workItem: WorkItem,
	context: { repo: string; taskId: string; branch: string; baseBranch: string },
): string {
	const { repo, branch, baseBranch } = context;
	return [
		'You are a senior software engineer implementing a work item end to end.',
		'',
		...PIPELINE_PHASE_GUARD,
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
		'Do not merge the PR — a human does that. Keep the change scoped to the work item.',
		'',
		'--- WORK ITEM ---',
		`Title: ${workItem.title}`,
		`URL: ${workItem.url}`,
		'',
		'Description:',
		workItem.description || '(no description provided)',
	].join('\n');
}

/**
 * Wrap the opened PR URL in a comment body that marks it as SWARM's
 * implementation output and points the human at the PR now awaiting review.
 * The trailing note depends on `autoAdvance`: when on (the default), the item
 * has already moved; when off, the human still needs to move it themselves.
 */
export function implementationCommentBody(
	prUrl: string,
	autoAdvance = DEFAULT_AUTO_ADVANCE,
): string {
	const note = autoAdvance
		? '_Generated by SWARM (Implementation phase). This item has moved to **In review**._'
		: '_Generated by SWARM (Implementation phase). Move this item to **In review** yourself when ready._';
	return [
		'## 🚀 Implementation complete',
		'',
		`A pull request is open and ready for review: ${prUrl.trim()}`,
		'',
		'---',
		note,
	].join('\n');
}

/**
 * Log a failed implementation run's captured output before the phase throws, so
 * the worker (SWARM-17) that marks the job failed has the agent's own
 * stdout/stderr to diagnose *why* — the thrown Error carries only a message.
 * Output is already bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, workItemId: string, agent: AgentCliResult): void {
	logger.error('Phase failed - Implementation — agent output', {
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

/** Read an agent's concise blocker handoff, if it supplied one. */
function readBlockedReason(worktreePath: string): string | undefined {
	const path = join(worktreePath, BLOCKED_REASON_FILENAME);
	if (!existsSync(path)) return undefined;
	const reason = readFileSync(path, 'utf8').trim();
	return reason.length > 0 ? reason.slice(0, 2_000) : undefined;
}

/**
 * Run the Implementation phase for one work item. Moves the item to "In
 * progress" to report that work has started, provisions a worktree on the
 * task branch, runs the implementer agent to build the change and open a PR,
 * posts the PR link as a comment on the linked Issue, and moves the item to
 * "In review".
 *
 * Throws if the agent exits non-zero or produced no PR URL — an implementation
 * run that didn't open a PR is a failed job, not a soft miss
 * (ai/CODING_STANDARDS.md "Error handling"), and the throw lets the worker mark
 * the job failed. The worktree is always removed, success or failure; the pushed
 * branch survives cleanup so the PR is unaffected.
 *
 * Note that `GitWorktreeManager.cleanup` removes the worktree but not the local
 * `<branchPrefix><taskId>` branch it created — deliberately, so a *successful*
 * run leaves the branch for Review/Respond-to-review/Respond-to-CI to check
 * out again. A re-run after a mid-flight failure would otherwise hit
 * `git worktree add -b` "branch already exists" on the leftover branch;
 * `GitWorktreeManager.provision` now reaps that orphan itself when it's
 * provably safe to (no matching ref on `origin`), so this phase doesn't need
 * its own retry/leftover-branch handling.
 */
/**
 * Acquire the task-branch worktree for the implementation run. When resuming a
 * Claude session (`resumeSessionId`) it reuses the existing worktree so the
 * agent can `--resume` in place; if that worktree is gone (`reuse` returns
 * undefined) it falls through to a fresh provision. Otherwise it provisions —
 * reusing the existing task branch when retrying a PM phase
 * (`resumeExistingBranch`), or creating a new branch. `resumed` reports whether
 * a session worktree was actually reused, so the caller only threads the resume
 * session id through when the checkout it belongs to is really in place.
 */
async function acquireImplementationWorktree(
	worktrees: GitWorktreeManager,
	taskId: string,
	branch: string,
	resumeSessionId: string | undefined,
	resumeExistingBranch: boolean,
): Promise<{ handle: WorktreeHandle; resumed: boolean }> {
	return acquireResumableWorktree(worktrees, taskId, branch, false, resumeSessionId, () =>
		resumeExistingBranch
			? worktrees.provision(taskId, { createBranch: false, branch })
			: worktrees.provision(taskId),
	);
}

/**
 * Read the PR URL the implementation agent handed back through
 * {@link OPENED_PR_FILENAME}. Throws a descriptive error when the file is
 * missing (surfacing a `blocked` reason the agent may have written instead) or
 * empty. `onInvalid` runs before each throw so the caller can log the captured
 * agent output alongside the failure.
 */
export async function runImplementationPhase(
	options: RunImplementationPhaseOptions,
): Promise<ImplementationPhaseResult> {
	const {
		project,
		workItem,
		taskId,
		pm,
		cli = DEFAULT_IMPLEMENTATION_CLI,
		model,
		sessionId,
		resumeSessionId,
		autoAdvance = DEFAULT_AUTO_ADVANCE,
		resumeExistingBranch = false,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const legacyMode = options.getToken !== undefined && options.delivery === undefined;
	const agentToken = await (options.getToken ?? getPersonaToken)(project, 'implementer');

	logger.info(`Phase started - Implementation — running ${describeAgent(cli, model)}`, {
		taskId,
		workItemId: workItem.id,
		cli,
		model,
	});

	// Resolved first: a missing implementer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	// Report the pickup before doing any work — including before provisioning —
	// so a human watching the board sees "In progress" as soon as the worker
	// commits to this task, not only once the (possibly long) agent run finishes.
	await pm.moveWorkItem(workItem.id, START_STATUS);

	// Task-branch checkout (createBranch defaults to true): the agent commits and
	// pushes here, so — unlike Planning — this is not a detached, throwaway HEAD.
	const { handle, resumed } = await acquireImplementationWorktree(
		worktrees,
		taskId,
		`${project.branchPrefix}${taskId}`,
		resumeSessionId,
		resumeExistingBranch,
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
						buildImplementationPrompt(workItem, {
							repo: project.repo,
							taskId,
							branch: handle.branch,
							baseBranch: project.baseBranch,
						}),
					],
					// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
					// call the agent makes (including `gh pr create`) acts as the
					// implementer persona, not the worker host's own logged-in account.
					maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
					logContext: { taskId, phase: 'implementation', workItemId: workItem.id },
					timeoutMs,
					signal,
					env: { GH_TOKEN: agentToken },
				});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, workItem.id, agent);
			const error = agentRunError(
				agent,
				`Implementation agent (${cli}) exited with code ${agent.exitCode}`,
				` for task '${taskId}'`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		if (!existsSync(join(handle.path, OPENED_PR_FILENAME))) {
			const blockedReason = readBlockedReason(handle.path);
			if (blockedReason)
				throw new Error(`Implementation blocked for task '${taskId}': ${blockedReason}`);
			if (legacyMode)
				throw new Error(`Implementation agent (${cli}) did not write ${OPENED_PR_FILENAME}`);
		}
		if (legacyMode) {
			const prUrl = readFileSync(join(handle.path, OPENED_PR_FILENAME), 'utf8').trim();
			if (!prUrl)
				throw new Error(`Implementation agent (${cli}) wrote an empty ${OPENED_PR_FILENAME}`);
			const commentId = await pm.addComment(
				workItem.id,
				implementationCommentBody(prUrl, autoAdvance),
			);
			if (autoAdvance) await pm.moveWorkItem(workItem.id, NEXT_STATUS);
			return {
				prUrl,
				branch: handle.branch,
				commentId,
				movedTo: autoAdvance ? NEXT_STATUS : undefined,
				agent,
			};
		}
		const handoff = readHandoff(handle.path, OPENED_PR_FILENAME, ImplementationHandoffSchema);
		const delivery =
			options.delivery ??
			(await new GitHubSCMIntegration().deliveryProvider(project, 'implementer'));
		const deliveryId = deliveryIdentity(['implementation', project.repo, taskId, handle.branch]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (!progress.commitSha) {
			progress.commitSha = await commitPreparedTree(
				handle.path,
				handoff.commitSubject,
				delivery.commitIdentity,
			);
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pushed) {
			await delivery.pushBranch(handle.path, handle.branch, progress.commitSha);
			progress.pushed = true;
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pullRequestUrl) {
			const pull =
				(await delivery.findPullRequest(handle.branch)) ??
				(await delivery.createPullRequest({
					baseBranch: project.baseBranch,
					branch: handle.branch,
					title: workItem.title,
					body: `Closes #${taskId}\n\n${handoff.summary}`,
				}));
			progress.pullRequestNumber = pull.number;
			progress.pullRequestUrl = pull.url;
			saveDeliveryProgress(handle.path, progress);
		}
		const prUrl = progress.pullRequestUrl;

		const commentId = await pm.addComment(
			workItem.id,
			implementationCommentBody(prUrl, autoAdvance),
		);
		if (autoAdvance) {
			await pm.moveWorkItem(workItem.id, NEXT_STATUS);
		}

		logger.info('Phase finished - Implementation', {
			taskId,
			workItemId: workItem.id,
			branch: handle.branch,
			prUrl,
			commentId,
			movedTo: autoAdvance ? NEXT_STATUS : undefined,
		});

		return {
			prUrl,
			branch: handle.branch,
			commentId,
			movedTo: autoAdvance ? NEXT_STATUS : undefined,
			agent,
		};
	} catch (error) {
		if (!legacyMode && hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('Implementation delivery deferred for retry', {
				cause: error,
			});
		}
		throw error;
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'implementation phase');
	}
}
