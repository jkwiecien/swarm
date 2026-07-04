/**
 * The worker's job processor — the Phase-3 wiring: dequeued job → trigger
 * lookup → worktree (SWARM-14) → environment graft (SWARM-15) → agent CLI
 * (SWARM-16) → cleanup (ai/ARCHITECTURE.md "Components").
 *
 * Queue-agnostic on purpose: `processJob` takes an already-validated `SwarmJob`
 * and knows nothing about BullMQ, so tests drive it directly and the entry
 * point (`src/worker/index.ts`) stays a thin shell.
 */

import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import { runAgentCli } from '../harness/agent-cli.js';
import { logger } from '../lib/logger.js';
import type { SwarmJob } from '../queue/jobs.js';
import type { TriggerRegistry } from '../triggers/registry.js';
import type { TriggerContext } from '../triggers/types.js';
import { graftEnvironment } from '../worktree/graft.js';
import { GitWorktreeManager } from './git-worktree-manager.js';

/**
 * Cap on captured agent stdout/stderr per stream. Long agent runs are chatty;
 * unbounded capture in a long-lived worker process is a slow memory leak
 * (`RunAgentCliOptions.maxOutputBytes` — the harness told SWARM-17 to set this).
 */
export const MAX_AGENT_OUTPUT_BYTES = 10 * 1024 * 1024;

/** What became of a dequeued job — returned to BullMQ as the job's result. */
export type JobOutcome =
	| { status: 'no-trigger' }
	| {
			status: 'agent-succeeded' | 'agent-failed';
			taskId: string;
			branch: string;
			exitCode: number | null;
			signal: NodeJS.Signals | null;
			timedOut: boolean;
			durationMs: number;
	  };

/**
 * Process one dequeued job end to end.
 *
 * A job no handler claims completes as `no-trigger` — with the pipeline-phase
 * handlers (SWARM-18…21) not registered yet, that's every job today. A job
 * whose agent ran and exited non-zero completes as `agent-failed` rather than
 * throwing: the agent run isn't idempotent, so a BullMQ retry storm is worse
 * than surfacing the failure in the outcome (reporting it to the PM board is
 * the phase handlers' job). Only infrastructure errors — unknown project,
 * worktree provisioning, graft, spawn failures — throw and fail the job.
 */
export async function processJob(job: SwarmJob, registry: TriggerRegistry): Promise<JobOutcome> {
	const project = await findProjectByIdFromDb(job.projectId);
	if (!project) {
		// The producer only enqueues for projects it resolved from Postgres, so a
		// miss here means the project was deleted mid-flight — fail loudly.
		throw new Error(`Job references unknown project '${job.projectId}'`);
	}

	const ctx: TriggerContext =
		job.type === 'github'
			? { project, deliveryId: job.deliveryId, source: 'github', event: job.event }
			: { project, deliveryId: job.deliveryId, source: 'github-projects', event: job.event };

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

	const worktrees = new GitWorktreeManager(project);
	const handle = await worktrees.provision(trigger.taskId, trigger.worktree);
	try {
		graftEnvironment(project.repoRoot, handle.path);

		const result = await runAgentCli({
			cli: trigger.cli,
			cwd: handle.path,
			args: trigger.args,
			env: trigger.env,
			timeoutMs: trigger.timeoutMs,
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
		});

		const succeeded = result.exitCode === 0;
		if (!succeeded) {
			logger.error('Agent run failed', {
				projectId: project.id,
				taskId: trigger.taskId,
				cli: trigger.cli,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
			});
		}
		return {
			status: succeeded ? 'agent-succeeded' : 'agent-failed',
			taskId: handle.taskId,
			branch: handle.branch,
			exitCode: result.exitCode,
			signal: result.signal,
			timedOut: result.timedOut,
			durationMs: result.durationMs,
		};
	} finally {
		// Cleanup must not mask the run's real outcome/error: a failure here just
		// leaves a stale worktree behind (visible via GitWorktreeManager.list()).
		try {
			await worktrees.cleanup(trigger.taskId);
		} catch (err) {
			logger.error('Worktree cleanup failed — stale worktree left behind', {
				projectId: project.id,
				taskId: trigger.taskId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
