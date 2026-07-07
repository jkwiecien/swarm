/**
 * The worker's job processor — the Phase-3 wiring: dequeued job → trigger
 * lookup → pipeline phase (ai/ARCHITECTURE.md "Components").
 *
 * A matched trigger names one of the pipeline phases plus its inputs
 * (`src/triggers/types.ts`); this dispatches on that phase and hands off to the
 * phase orchestrator (`src/pipeline/*`), which owns the whole run — worktree
 * provisioning + environment graft (SWARM-14/15), the agent CLI (SWARM-16),
 * reading its hand-off file, posting back to the PM board, and cleanup. The
 * worker's job here is just to resolve the project, build the PM provider the
 * PM-driven phases need, and translate the phase's result (or failure) into a
 * `JobOutcome`.
 *
 * Queue-agnostic on purpose: `processJob` takes an already-validated `SwarmJob`
 * and knows nothing about BullMQ, so tests drive it directly and the entry
 * point (`src/worker/index.ts`) stays a thin shell.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import type { AgentCliResult } from '../harness/agent-cli.js';
import { createGitHubProjectsProvider } from '../integrations/pm/github-projects/provider.js';
import { logger } from '../lib/logger.js';
import { runImplementationPhase } from '../pipeline/implementation.js';
import { runPlanningPhase } from '../pipeline/planning.js';
import { runRespondToCiPhase } from '../pipeline/respond-to-ci.js';
import { runRespondToReviewPhase } from '../pipeline/respond-to-review.js';
import { runReviewPhase } from '../pipeline/review.js';
import type { SwarmJob } from '../queue/jobs.js';
import type { TriggerRegistry } from '../triggers/registry.js';
import type { TriggerContext, TriggerPhase, TriggerResult } from '../triggers/types.js';

/** What became of a dequeued job — returned to BullMQ as the job's result. */
export type JobOutcome =
	| { status: 'no-trigger' }
	| {
			status: 'phase-succeeded';
			phase: TriggerPhase;
			taskId: string;
			exitCode: number | null;
			signal: NodeJS.Signals | null;
			timedOut: boolean;
			durationMs: number;
	  }
	| {
			status: 'phase-failed';
			phase: TriggerPhase;
			taskId: string;
			error: string;
	  };

/**
 * Run the pipeline phase a matched trigger resolved to. The orchestrators
 * differ in their inputs but all resolve to a result carrying the agent run
 * (`.agent`); the phase owns its own worktree lifecycle, so this doesn't
 * provision anything. `signal` (the worker's shutdown signal) is threaded
 * through so a graceful shutdown kills any in-flight agent CLI.
 */
function runPhase(
	trigger: TriggerResult,
	project: ProjectConfig,
	signal?: AbortSignal,
): Promise<{ agent: AgentCliResult }> {
	switch (trigger.phase) {
		case 'planning':
			return runPlanningPhase({
				project,
				workItem: trigger.workItem,
				taskId: trigger.taskId,
				pm: createGitHubProjectsProvider(project),
				cli: project.agents?.planning?.cli,
				model: project.agents?.planning?.model,
				autoAdvance: project.pipeline?.planning?.autoAdvance,
				signal,
			});
		case 'implementation':
			return runImplementationPhase({
				project,
				workItem: trigger.workItem,
				taskId: trigger.taskId,
				pm: createGitHubProjectsProvider(project),
				cli: project.agents?.implementation?.cli,
				model: project.agents?.implementation?.model,
				autoAdvance: project.pipeline?.implementation?.autoAdvance,
				signal,
			});
		case 'review':
			return runReviewPhase({
				project,
				prNumber: trigger.prNumber,
				headSha: trigger.headSha,
				taskId: trigger.taskId,
				cli: project.agents?.review?.cli,
				model: project.agents?.review?.model,
				signal,
			});
		case 'respond-to-review':
			return runRespondToReviewPhase({
				project,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				reviewId: trigger.reviewId,
				taskId: trigger.taskId,
				cli: project.agents?.respondToReview?.cli,
				model: project.agents?.respondToReview?.model,
				signal,
			});
		case 'respond-to-ci':
			return runRespondToCiPhase({
				project,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
				taskId: trigger.taskId,
				cli: project.agents?.respondToCi?.cli,
				model: project.agents?.respondToCi?.model,
				signal,
			});
	}
}

/**
 * Process one dequeued job end to end.
 *
 * A job no handler claims completes as `no-trigger`. A job whose phase ran but
 * failed — the agent exited non-zero, a hand-off file was missing, or worktree
 * setup failed — completes as `phase-failed` rather than throwing: an agent run
 * isn't idempotent, so a BullMQ retry storm is worse than surfacing the failure
 * in the outcome (the phase already logs the agent's own stdout/stderr, and
 * reporting to the PM board is the phase's job). The one thing that still
 * throws is an unknown project — infrastructure the job can't proceed without.
 *
 * `signal` is the worker's shutdown signal: aborting kills a running agent CLI
 * (SIGTERM→SIGKILL) so graceful shutdown doesn't hang behind a long run.
 */
export async function processJob(
	job: SwarmJob,
	registry: TriggerRegistry,
	signal?: AbortSignal,
): Promise<JobOutcome> {
	const project = await findProjectByIdFromDb(job.projectId);
	if (!project) {
		// The producer only enqueues for projects it resolved from Postgres, so a
		// miss here means the project was deleted mid-flight — fail loudly.
		throw new Error(`Job references unknown project '${job.projectId}'`);
	}

	const ctx: TriggerContext =
		job.type === 'github'
			? {
					project,
					deliveryId: job.deliveryId,
					recheckAttempt: job.recheckAttempt,
					source: 'github',
					event: job.event,
				}
			: {
					project,
					deliveryId: job.deliveryId,
					recheckAttempt: job.recheckAttempt,
					source: 'github-projects',
					event: job.event,
				};

	const trigger = await registry.dispatch(ctx);
	if (!trigger) {
		logger.info('Job matched no trigger — completing as a no-op', {
			projectId: project.id,
			source: ctx.source,
			eventType: job.event.eventType,
			deliveryId: job.deliveryId,
		});
		return { status: 'no-trigger' };
	}

	try {
		const result = await runPhase(trigger, project, signal);
		logger.info('Pipeline phase completed', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
		});
		return {
			status: 'phase-succeeded',
			phase: trigger.phase,
			taskId: trigger.taskId,
			exitCode: result.agent.exitCode,
			signal: result.agent.signal,
			timedOut: result.agent.timedOut,
			durationMs: result.agent.durationMs,
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.error('Pipeline phase failed', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error,
		});
		// The review handler's claim intentionally survives a failed run: the review
		// agent submits its formal `gh pr review` *inside* the run, so a phase that
		// threw afterward may have already posted the review — releasing the claim
		// here would let a sibling event for the same PR+SHA post a duplicate, the
		// exact incident the dedup guards against. The 5-minute TTL reaps a claim
		// whose run genuinely failed before submitting. See review-dispatch-dedup.ts.
		return { status: 'phase-failed', phase: trigger.phase, taskId: trigger.taskId, error };
	}
}
