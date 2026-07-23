/**
 * Termination-time worktree settlement — the lifecycle foundation for cleaning
 * up after a user *terminates* a run (as opposed to a run failing or deferring
 * on its own).
 *
 * When a running or deferred run is terminated by the user and has fully
 * stopped, its checkout, worktree lease, and persisted recovery record must be
 * brought to a single consistent terminal outcome. This module owns that
 * decision so the running-run path (`src/worker/consumer.ts`) and the
 * deferred-run path (`src/api/routers/runs.ts`) settle a termination the same
 * way rather than each improvising it:
 *
 *   - a **missing** checkout is already settled — nothing to clean;
 *   - an **explicit resumable session** is preserved: the checkout is kept and
 *     the live worktree lease released, because the database recovery record
 *     (`recovery.state = "preserved"` + `agentSessionId`) — not a live lease —
 *     is what pins the checkout for retention until a resume
 *     (`hasResumableDeferredRun`, `src/worktree/retention.ts`);
 *   - with **no resumable session**, the checkout is removed only once it is
 *     provably safe: not owned by a *different* live run, `isClean()`, and free
 *     of unpushed commits;
 *   - otherwise the work is **retained** with a blocked reason (`dirty`,
 *     `unpushed`, or `live-leased`) rather than force-removed.
 *
 * It fails closed: `GitWorktreeManager.isClean()`/`hasUnpushedWork()` both treat
 * any git error as unsafe (dirty / has-unpushed), so a validation failure
 * surfaces as a blocked reason and never as a forced removal of protected work.
 *
 * The caller must invoke this only *after* the target run is known to have
 * stopped — never while it may still be executing an agent.
 */

import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import type { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { isWorktreeLeased, releaseWorktreeLease } from './worktree-lease.js';

/** The blocked reasons this settlement can persist, a subset of the run recovery record's. */
export type TerminationBlockedReason = 'dirty' | 'unpushed' | 'live-leased';

/** The outcome of reconciling a terminated run's checkout. */
export type TerminationCleanupResult =
	/** No checkout on disk — already settled. */
	| { outcome: 'absent' }
	/** Checkout kept for an explicit resumable session; the lease was released. */
	| { outcome: 'preserved'; agentSessionId: string }
	/** Checkout was clean, pushed, and unleased — removed. */
	| { outcome: 'removed' }
	/** Protected work retained rather than removed. */
	| { outcome: 'blocked'; blockedReason: TerminationBlockedReason };

/**
 * Reconcile a terminated run's worktree, lease, and (implied) recovery record
 * once the run has stopped. Returns what happened so the caller can persist an
 * exactly-matching recovery record — `preserved` with the session, `blocked`
 * with a reason, or nothing when the checkout was removed or never existed. A
 * retained session id must never outlive the checkout it would resume, so the
 * caller persists no `agentSessionId` for a `removed`/`absent`/`blocked` result.
 *
 * @param stoppedRunHeldLease whether the terminated run itself held this
 *   worktree's lease. `true` for a running run that provisioned its own
 *   checkout (its lease is its own, not a foreign live run's, so it never
 *   blocks removal); `false` for a deferred run that never took the lease (a
 *   present lease then belongs to a *different* live run and protects the
 *   checkout as `live-leased`).
 */
export async function reconcileTerminatedWorktree(
	worktrees: GitWorktreeManager,
	projectId: string,
	taskId: string,
	sessionToPreserve: string | null,
	stoppedRunHeldLease: boolean,
): Promise<TerminationCleanupResult> {
	const path = worktrees.worktreePath(taskId);
	if (!existsSync(path)) {
		// No checkout to reconcile. Drop any stale lease the stopped run left so a
		// later run or retention sweep isn't misled by a marker with no directory.
		await releaseWorktreeLease(projectId, taskId);
		return { outcome: 'absent' };
	}

	if (sessionToPreserve) {
		// Explicit resumable recovery: hand the checkout's protection to the
		// database recovery record and release the live lease.
		await releaseWorktreeLease(projectId, taskId);
		logger.debug('termination settlement: preserving checkout for resumable session', {
			projectId,
			taskId,
		});
		return { outcome: 'preserved', agentSessionId: sessionToPreserve };
	}

	if (!stoppedRunHeldLease && (await isWorktreeLeased(projectId, taskId))) {
		// A different live run owns this checkout — leave it and record why.
		logger.info('termination settlement: retaining live-leased checkout', { projectId, taskId });
		return { outcome: 'blocked', blockedReason: 'live-leased' };
	}

	if (!(await worktrees.isClean(taskId))) {
		logger.info('termination settlement: retaining dirty checkout', { projectId, taskId });
		return { outcome: 'blocked', blockedReason: 'dirty' };
	}

	if (await worktrees.hasUnpushedWork(taskId)) {
		logger.info('termination settlement: retaining checkout with unpushed commits', {
			projectId,
			taskId,
		});
		return { outcome: 'blocked', blockedReason: 'unpushed' };
	}

	// Clean, pushed, unleased, and nothing to resume — safe to remove.
	// `cleanup()` releases the lease and removes the checkout.
	await worktrees.cleanup(taskId);
	logger.info('termination settlement: removed clean checkout', { projectId, taskId });
	return { outcome: 'removed' };
}
