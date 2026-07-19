/**
 * Cross-CLI session resume — the shared half of "defer a rate-limited or
 * timed-out phase and continue it later instead of re-doing its work".
 *
 * Every pipeline phase runs an agent CLI in a worktree; when that run hits a
 * usage/session limit or the wall-clock timeout, the agent may already have done
 * useful work whose reasoning lives in its CLI session (and, for the
 * implementer phases, whose partial edits live in the worktree). Rather than
 * throw both away, the worker defers the phase and retries it with the CLI's own
 * resume mechanism — `claude --resume`, `agy --conversation`, or
 * `codex exec resume` (wired per-CLI in `src/harness/agent-cli.ts`).
 *
 * This module holds the phase-side pieces every phase shares, so the six phases
 * don't each re-implement them: which failures are worth preserving for, how to
 * reuse a preserved checkout, how to thread the session id into the run, and how
 * to skip cleanup when a checkout must survive for the retry. It is CLI-agnostic
 * — the id a run created is captured into {@link AgentCliResult.sessionId} by the
 * harness for all three CLIs, so this code never special-cases one.
 */

import type { AgentCliResult } from '@/harness/agent-cli.js';
import type { AgentRunError } from '@/harness/agent-failure.js';
import { logger } from '@/lib/logger.js';
import { isRunCancellationRequested } from '@/queue/cancellation.js';
import { hasDeliveryProgress } from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';

/** The session inputs every resumable phase accepts, threaded to the agent run. */
export interface PhaseSessionOptions {
	/**
	 * Session UUID to *assign* to a fresh run — only `claude` honors it
	 * (`--session-id`), so it's the worker's `runId`; codex/agy ignore it and have
	 * their id captured post-run instead.
	 */
	sessionId?: string;
	/** Existing session/thread id to *resume* (any CLI). Set on a retry, not a fresh run. */
	resumeSessionId?: string;
	/** The database run id. */
	runId?: string;
}

/**
 * Whether a failed run's worktree should be kept for a resume retry: only when
 * the failure is one the run can meaningfully continue from — a `rate-limit`
 * (quota back later) or a `timeout` (the wall-clock kill may have interrupted
 * work in progress) — *and* the run got far enough to create a session to
 * resume (its id was captured into {@link AgentCliResult.sessionId}). Every
 * other failure (a hard error, an abort, a capacity banner, an instant
 * credential failure) cleans up and retries from scratch as before.
 */
export function shouldPreserveForResume(error: AgentRunError): boolean {
	const kind = error.failure.kind;
	if (kind !== 'rate-limit' && kind !== 'timeout' && kind !== 'stalled') return false;
	return error.agent?.sessionId !== undefined;
}

import { existsSync } from 'node:fs';
import {
	claimWorktreeLease,
	isWorktreeLeased,
	releaseWorktreeLease,
} from '@/worktree/worktree-lease.js';

export class BlockedRecoveryError extends Error {
	constructor(
		readonly reason: 'dirty' | 'unpushed' | 'live-leased' | 'missing-validation',
		message: string,
	) {
		super(message);
		this.name = 'BlockedRecoveryError';
	}
}

export async function executeRecoveryGate(
	worktrees: GitWorktreeManager,
	taskId: string,
	recoveryMode: 'resume' | 'fresh' | undefined,
	expectedSessionId: string | undefined,
	projectId: string,
): Promise<{ reuseHandle: WorktreeHandle | null }> {
	const path = worktrees.worktreePath(taskId);
	const exists = existsSync(path);

	if (!exists) {
		if (recoveryMode === 'resume') {
			throw new BlockedRecoveryError(
				'missing-validation',
				`Cannot resume task '${taskId}' — worktree checkout does not exist.`,
			);
		}
		return { reuseHandle: null };
	}

	const leased = await isWorktreeLeased(projectId, taskId);
	if (leased) {
		throw new BlockedRecoveryError(
			'live-leased',
			`Worktree for task '${taskId}' is leased by a live run.`,
		);
	}

	await claimWorktreeLease(projectId, taskId);

	if (recoveryMode === 'resume') {
		if (!expectedSessionId) {
			await releaseWorktreeLease(projectId, taskId);
			throw new BlockedRecoveryError(
				'missing-validation',
				`Cannot resume task '${taskId}' — missing expected session ID.`,
			);
		}

		let branch = '';
		let detached = false;
		try {
			const symbolicRef = await (
				worktrees as unknown as { git: (args: string[], cwd?: string) => Promise<string> }
			).git(['symbolic-ref', '--short', '-q', 'HEAD'], path);
			branch = symbolicRef.trim();
			if (!branch) {
				detached = true;
				const headSha = await (
					worktrees as unknown as { git: (args: string[], cwd?: string) => Promise<string> }
				).git(['rev-parse', 'HEAD'], path);
				branch = headSha.trim();
			}
		} catch {
			detached = true;
			branch = 'HEAD';
		}

		return {
			reuseHandle: {
				taskId,
				path,
				branch,
				detached,
			},
		};
	}

	if (recoveryMode === 'fresh') {
		const clean = await worktrees.isClean(taskId);
		if (!clean) {
			await releaseWorktreeLease(projectId, taskId);
			throw new BlockedRecoveryError(
				'dirty',
				`Worktree for task '${taskId}' has uncommitted changes.`,
			);
		}

		const unpushed = await worktrees.hasUnpushedWork(taskId);
		if (unpushed) {
			await releaseWorktreeLease(projectId, taskId);
			throw new BlockedRecoveryError(
				'unpushed',
				`Worktree for task '${taskId}' has unpushed commits.`,
			);
		}

		logger.info(
			'recovery: worktree is clean and has no unpushed work — removing it for fresh retry',
			{ taskId, path },
		);
		await worktrees.cleanup(taskId);
		return { reuseHandle: null };
	}

	return { reuseHandle: null };
}

/**
 * Acquire a phase's worktree, reusing a preserved checkout for either an agent
 * session retry or a delivery retry. Delivery reuse additionally requires its
 * progress sidecar, so an unrelated stale checkout is never adopted. `resumed`
 * reports whether an agent session was resumed; `deliveryResumed` reports a
 * verified deterministic-delivery continuation.
 */
export async function acquireResumableWorktree(
	worktrees: GitWorktreeManager,
	taskId: string,
	reuseBranch: string,
	reuseDetached: boolean,
	resumeSessionId: string | undefined,
	provisionFresh: () => Promise<WorktreeHandle>,
	resumeDelivery = false,
	recoveryMode?: 'resume' | 'fresh',
	projectId?: string,
): Promise<{ handle: WorktreeHandle; resumed: boolean; deliveryResumed: boolean }> {
	if (recoveryMode) {
		const { reuseHandle } = await executeRecoveryGate(
			worktrees,
			taskId,
			recoveryMode,
			resumeSessionId,
			projectId ?? (worktrees as unknown as { project: { id: string } }).project.id,
		);
		if (reuseHandle) {
			return { handle: reuseHandle, resumed: true, deliveryResumed: false };
		}
	}

	const reused = resumeDelivery
		? await worktrees.reuse(taskId, reuseBranch, reuseDetached, hasDeliveryProgress)
		: resumeSessionId
			? await worktrees.reuse(taskId, reuseBranch, reuseDetached)
			: undefined;
	if (reused)
		return {
			handle: reused,
			resumed: resumeSessionId !== undefined,
			deliveryResumed: resumeDelivery,
		};
	return { handle: await provisionFresh(), resumed: false, deliveryResumed: false };
}

/**
 * The `sessionId`/`resumeSessionId` to hand a single agent run: resume the prior
 * session when its checkout was reused, otherwise assign a fresh id. Never both
 * — a run either continues an existing session or starts a new one.
 */
export function sessionRunArgs(
	session: PhaseSessionOptions,
	resumed: boolean,
): PhaseSessionOptions {
	return {
		sessionId: resumed ? undefined : session.sessionId,
		resumeSessionId: resumed ? session.resumeSessionId : undefined,
	};
}

export async function cleanupUnlessPreserved(
	worktrees: GitWorktreeManager,
	taskId: string,
	preserveForResume: boolean,
	phaseName: string,
	runId?: string,
): Promise<void> {
	try {
		const isCancelled = runId ? await isRunCancellationRequested(runId) : false;
		if (preserveForResume || isCancelled) {
			logger.debug(`${phaseName}: preserving worktree for agent session resume`, { taskId, runId });
			return;
		}
		await worktrees.cleanup(taskId);
	} catch (error) {
		logger.error(`${phaseName}: worktree cleanup failed`, {
			taskId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Re-export for phases that annotate their captured result. */
export type { AgentCliResult };
