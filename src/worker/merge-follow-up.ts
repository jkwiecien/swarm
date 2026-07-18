/**
 * Durable follow-up for the Review phase's provider-neutral merge automation
 * (`src/scm/merge.ts`, issue #253) — closes the gap where a `not-ready`
 * outcome right after an approval (GitHub still converging on the
 * just-submitted review) was swallowed as non-fatal with no recheck, leaving
 * an eligible PR open indefinitely (issue #278).
 *
 * A follow-up runs entirely outside the agent pipeline: it only re-invokes the
 * injected `ScmMergeProvider`, never provisioning a worktree or starting an
 * agent — the Review phase (and its submitted review) already completed, and
 * re-running it would resubmit nothing useful while wasting an agent
 * invocation. Scheduling goes through the dedicated
 * `src/queue/merge-follow-up.ts` queue, kept off `swarm-jobs` so this never
 * contends with, or is mistaken for, a trigger-driven `SwarmJob` retry.
 */

import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	getPendingReviewMergeFollowUps,
	updateReviewMergeOutcome,
} from '../db/repositories/runsRepository.js';
import { GitHubSCMIntegration } from '../integrations/scm/github/scm-integration.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueueMergeFollowUp, type MergeFollowUpJob } from '../queue/merge-follow-up.js';
import type { MergePullRequestOutcome } from '../scm/merge.js';

/** Terminal outcome recorded once the bounded retry budget is spent without merging. */
export const MERGE_RETRY_EXHAUSTED = 'retry-exhausted' as const;

/** Every value the `runs.review_merge_outcome` column can hold. */
export type ReviewMergeOutcomeStatus =
	| MergePullRequestOutcome['status']
	| typeof MERGE_RETRY_EXHAUSTED;

/**
 * Bounded backoff, coded constants — merge-follow-up retry policy is
 * intentionally not project-configurable, mirroring the fixed budget the
 * rate-limit retry loop uses (`MAX_RATE_LIMIT_RETRIES`,
 * `src/worker/consumer.ts`). The delay doubles from 15s up to a 5-minute
 * ceiling: GitHub's own review-state propagation typically clears within
 * seconds, so six attempts comfortably rides that out while staying bounded.
 */
export const MAX_MERGE_FOLLOW_UP_ATTEMPTS = 6;
const MERGE_FOLLOW_UP_BASE_DELAY_MS = 15_000;
const MERGE_FOLLOW_UP_MAX_DELAY_MS = 5 * 60_000;

/** The delay before follow-up attempt `attempt` (1-indexed) fires. */
export function mergeFollowUpDelayMs(attempt: number): number {
	return Math.min(
		MERGE_FOLLOW_UP_MAX_DELAY_MS,
		MERGE_FOLLOW_UP_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
	);
}

interface ScheduleMergeFollowUpInput {
	projectId: string;
	runId: string;
	prNumber: string;
	approvedHeadSha: string;
	/** 1-indexed follow-up attempt about to be scheduled. */
	attempt: number;
}

/**
 * Schedule the next merge-follow-up attempt, or record retry exhaustion once
 * the bounded budget is spent. Best-effort: a scheduling failure is logged,
 * never thrown — this always runs after the Review phase (or a prior
 * follow-up) already settled successfully, so a queue hiccup here must not
 * turn that into a failure.
 */
export async function scheduleMergeFollowUp(input: ScheduleMergeFollowUpInput): Promise<void> {
	if (input.attempt > MAX_MERGE_FOLLOW_UP_ATTEMPTS) {
		try {
			await updateReviewMergeOutcome(input.runId, {
				status: MERGE_RETRY_EXHAUSTED,
				message:
					'Merge automation gave up after repeated not-ready results; the pull request is approved but was left open for a manual merge.',
				attempt: input.attempt - 1,
				approvedHeadSha: input.approvedHeadSha,
			});
		} catch (err) {
			logger.error('Failed to persist merge-follow-up retry exhaustion', {
				runId: input.runId,
				error: describeError(err),
			});
		}
		logger.warn('Review merge follow-up: retry budget exhausted, leaving the PR open', {
			runId: input.runId,
			prNumber: input.prNumber,
		});
		return;
	}
	try {
		await enqueueMergeFollowUp(
			{
				projectId: input.projectId,
				runId: input.runId,
				prNumber: input.prNumber,
				approvedHeadSha: input.approvedHeadSha,
				attempt: input.attempt,
			},
			mergeFollowUpDelayMs(input.attempt),
		);
	} catch (err) {
		logger.error('Failed to schedule Review merge follow-up', {
			runId: input.runId,
			attempt: input.attempt,
			error: describeError(err),
		});
	}
}

/**
 * Record the Review phase's own immediate merge attempt (attempt 0) on its run
 * row and, when it's `not-ready`, schedule the first durable follow-up. Called
 * from the worker's Review success path (`src/worker/consumer.ts`) — never
 * from pipeline code, which must not schedule queue work
 * (`ai/RULES.md` §2's provider-neutral SCM boundary).
 */
export async function recordReviewMergeOutcome(input: {
	projectId: string;
	runId: string;
	prNumber: string;
	approvedHeadSha: string;
	outcome: MergePullRequestOutcome;
}): Promise<void> {
	try {
		await updateReviewMergeOutcome(input.runId, {
			status: input.outcome.status,
			message: input.outcome.message,
			attempt: 0,
			approvedHeadSha: input.approvedHeadSha,
		});
	} catch (err) {
		logger.error("Failed to persist the Review run's merge outcome", {
			runId: input.runId,
			error: describeError(err),
		});
	}
	if (input.outcome.status !== 'not-ready') return;
	await scheduleMergeFollowUp({
		projectId: input.projectId,
		runId: input.runId,
		prNumber: input.prNumber,
		approvedHeadSha: input.approvedHeadSha,
		attempt: 1,
	});
}

/**
 * Execute one durable merge-follow-up attempt: re-invoke the provider-neutral
 * merge capability (fresh PR state and approval re-checked from scratch —
 * `GitHubSCMIntegration.mergePullRequest`), persist the outcome on the
 * originating Review run, and schedule the next attempt if it's still
 * `not-ready`. Never provisions a worktree, starts an agent, or resubmits the
 * review — only the merge itself.
 */
export async function processMergeFollowUp(job: MergeFollowUpJob): Promise<void> {
	const project = await findProjectByIdFromDb(job.projectId);
	if (!project) {
		logger.warn('Review merge follow-up: unknown project — skipping', {
			projectId: job.projectId,
			runId: job.runId,
		});
		return;
	}

	const scm = new GitHubSCMIntegration();
	let outcome: MergePullRequestOutcome;
	try {
		outcome = await scm.mergePullRequest(project, Number(job.prNumber), job.approvedHeadSha);
	} catch (err) {
		outcome = { status: 'provider-error', message: describeError(err) };
	}

	try {
		await updateReviewMergeOutcome(job.runId, {
			status: outcome.status,
			message: outcome.message,
			attempt: job.attempt,
			approvedHeadSha: job.approvedHeadSha,
		});
	} catch (err) {
		logger.error('Failed to persist merge-follow-up outcome', {
			runId: job.runId,
			error: describeError(err),
		});
	}

	if (outcome.status === 'merged') {
		logger.info('Review merge follow-up: merged pull request', {
			runId: job.runId,
			prNumber: job.prNumber,
			attempt: job.attempt,
		});
		return;
	}
	if (outcome.status !== 'not-ready') {
		logger.warn('Review merge follow-up: terminal non-merge outcome', {
			runId: job.runId,
			prNumber: job.prNumber,
			status: outcome.status,
			message: outcome.message,
		});
		return;
	}

	await scheduleMergeFollowUp({
		projectId: project.id,
		runId: job.runId,
		prNumber: job.prNumber,
		approvedHeadSha: job.approvedHeadSha,
		attempt: job.attempt + 1,
	});
}

/**
 * Recover a merge-follow-up whose durable intent survived
 * (`runs.review_merge_outcome === 'not-ready'`) but whose delayed BullMQ job
 * did not (e.g. Redis lost its queued jobs across a restart). Re-scheduling is
 * safe even when the job actually still exists — `scheduleMergeFollowUp`'s
 * deterministic job id makes the re-add a no-op in that case. Called once at
 * worker startup, alongside the other run-reconciliation sweeps
 * (`src/worker/index.ts`).
 */
export async function recoverPendingMergeFollowUps(): Promise<void> {
	let pending: Awaited<ReturnType<typeof getPendingReviewMergeFollowUps>>;
	try {
		pending = await getPendingReviewMergeFollowUps();
	} catch (err) {
		logger.error('Failed to load pending review merge follow-ups at startup', {
			error: describeError(err),
		});
		return;
	}
	for (const run of pending) {
		if (!run.prNumber || !run.reviewMergeApprovedHeadSha) continue;
		await scheduleMergeFollowUp({
			projectId: run.projectId,
			runId: run.id,
			prNumber: run.prNumber,
			approvedHeadSha: run.reviewMergeApprovedHeadSha,
			attempt: (run.reviewMergeAttempt ?? 0) + 1,
		});
	}
	if (pending.length > 0) {
		logger.info('Recovered pending review merge follow-ups at startup', { count: pending.length });
	}
}
