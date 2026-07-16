/**
 * Worker entry point — the BullMQ consumer side of the router→worker queue
 * (ai/ARCHITECTURE.md "Components"). A long-lived process, not Cascade's
 * one-container-per-job model: the MVP runs one worker on the host (NOT in
 * Docker Compose — it needs the developer's PATH/auth for git and the agent
 * CLIs), pulling jobs off `swarm-jobs` one at a time (env-overridable pool).
 */

// Single canonical integration registration — same entrypoint as the router,
// so a provider can never be registered on one runtime surface but not another.
import '../integrations/entrypoint.js';

import { Worker } from 'bullmq';
import { runMigrations } from '../db/migrate.js';
import { upsertCliQuota } from '../db/repositories/cliQuotasRepository.js';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import {
	failOrphanedRunningRuns,
	failStaleRunningRuns,
} from '../db/repositories/runsRepository.js';
import { discoverCliQuotas } from '../harness/quota-discovery.js';
import { optionalEnv, requireEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { addFileSink, configureLogger, logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { closeRunCancellationRedis, subscribeToRunCancellations } from '../queue/cancellation.js';
import { QUEUE_NAME, SwarmJobSchema } from '../queue/jobs.js';
import { createTriggerRegistry, registerBuiltInTriggers } from '../triggers/index.js';
import { pruneStaleWorktrees } from '../worktree/retention.js';
import {
	type JobOutcome,
	processJob,
	reportInterruptedJobToBoard,
	resolveAgentTimeoutMs,
} from './consumer.js';
import { reenqueueDeferred } from './deferred-retry.js';
import { isJobStale, resolveMaxJobAgeMs } from './job-freshness.js';
import { resetProjectSlot } from './project-concurrency.js';
import { abortRun } from './run-cancellation.js';
import { resolveWorkerLockOptions } from './runtime-options.js';

// Tag every line this process emits so router and worker logs stay
// distinguishable in a shared stream (ai/ARCHITECTURE.md "Observability").
// This runs after the hoisted imports above (notably the integrations
// entrypoint), so any module that logs at import time would emit an untagged
// line before this call — nothing does today; keep it that way.
configureLogger({ component: 'worker' });

// Tee the worker's logs to a durable file (in addition to stdout) so an
// unattended run leaves a greppable record behind — a terminal scrollback is
// easy to lose, and the worker's runs are long. Defaults to `logs/worker.log`
// under the repo root; override the path (or point it elsewhere) with
// SWARM_LOG_FILE. The file always receives the JSON form (see logger.ts).
addFileSink(optionalEnv('SWARM_LOG_FILE', 'logs/worker.log'));

const rawConcurrency = optionalEnv('SWARM_WORKER_CONCURRENCY', '1');
const concurrency = Number(rawConcurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
	throw new Error(`SWARM_WORKER_CONCURRENCY must be a positive integer, got '${rawConcurrency}'`);
}

const { lockDuration, lockRenewTime } = resolveWorkerLockOptions();

const rawSweepInterval = optionalEnv('SWARM_WORKTREE_SWEEP_INTERVAL_MS', String(60 * 60 * 1000));
const sweepIntervalMs = Number(rawSweepInterval);
if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
	throw new Error(
		`SWARM_WORKTREE_SWEEP_INTERVAL_MS must be a positive integer, got '${rawSweepInterval}'`,
	);
}

// The default wall-clock timeout every agent run is bounded by (issue #165),
// resolved here too so the stale-run reconciliation below reaps a `running` row
// only once it has outlived any run that could still legitimately be behind it.
// Reading it at startup also validates `SWARM_AGENT_TIMEOUT_MS` (throws on a bad
// value) alongside the other worker knobs, rather than only when the first job
// runs.
const agentTimeoutMs = resolveAgentTimeoutMs();

// A worker can be deliberately offline while Redis keeps accepting webhooks.
// Those old board states are no longer actionable when it comes back, so do
// not let a restart replay work the operator already completed manually.
const maxJobAgeMs = resolveMaxJobAgeMs();

// How often the worker sweeps for stale `running` rows (a phase whose process
// died while the worker kept serving jobs — its finalize never landed). Cheap
// (one bounded UPDATE), so it can run far more often than the hourly worktree
// sweep; default every 5 min.
const rawStaleRunSweepInterval = optionalEnv(
	'SWARM_STALE_RUN_SWEEP_INTERVAL_MS',
	String(5 * 60 * 1000),
);
const staleRunSweepIntervalMs = Number(rawStaleRunSweepInterval);
if (!Number.isInteger(staleRunSweepIntervalMs) || staleRunSweepIntervalMs < 1) {
	throw new Error(
		`SWARM_STALE_RUN_SWEEP_INTERVAL_MS must be a positive integer, got '${rawStaleRunSweepInterval}'`,
	);
}

// Grace added on top of the largest configured timeout before a `running` row is
// judged stale: the harness's SIGTERM→SIGKILL grace plus headroom for a slow
// finalize write, so an in-flight run that is merely finishing up is never reaped.
const STALE_RUN_MARGIN_MS = 10 * 60 * 1000;

const registry = createTriggerRegistry();
registerBuiltInTriggers(registry);

// Bring the DB schema up to date before serving any job. This is required for
// direct/source starts and the opt-in `dev:worker:watch` mode alike; a restarted
// process must never run newer schema-referencing code against an older DB.
// Fatal on failure: crash loudly rather than serve jobs with broken run history.
try {
	await runMigrations();
} catch (err) {
	logger.error('Failed to apply database migrations — refusing to start', {
		error: describeError(err),
	});
	process.exit(1);
}

// Reconcile zombie runs left `running` by a prior crash or watch restart that
// killed the process before it wrote a terminal status — otherwise they show as
// "running" in the dashboard forever. Safe here (before the Worker pulls any
// job) because a fresh worker owns no in-flight run. Best-effort: a hiccup must
// not stop the worker from serving jobs.
try {
	const reconciled = await failOrphanedRunningRuns(
		'Worker restarted while this run was in progress',
	);
	if (reconciled > 0) {
		logger.debug('Reconciled orphaned running runs at startup', { count: reconciled });
	}
} catch (err) {
	logger.error('Failed to reconcile orphaned running runs at startup', {
		error: describeError(err),
	});
}

// Aborted on SIGTERM/SIGINT so an in-flight agent run is killed (SIGTERM→SIGKILL
// via `runAgentCli`'s signal option) instead of outliving the stop grace period.
const shutdown = new AbortController();

async function resetProjectSlots(): Promise<void> {
	try {
		const projects = await listAllProjectsFromDb();
		await Promise.all(projects.map((project) => resetProjectSlot(project.id)));
	} catch (err) {
		logger.error('Failed to reset project concurrency counters at startup', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

await resetProjectSlots();

async function runQuotaDiscovery(cheap = false): Promise<void> {
	try {
		logger.debug('Starting CLI capability/quota discovery...', { cheap });
		const snapshots = await discoverCliQuotas(cheap);
		for (const snapshot of snapshots) {
			await upsertCliQuota(snapshot.cli, snapshot.status, snapshot);
		}
		logger.debug('CLI capability/quota discovery completed and persisted.');
	} catch (err) {
		logger.error('Failed to run CLI capability/quota discovery', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// Run full discovery once immediately on startup
await runQuotaDiscovery(false);

const worker = new Worker(
	QUEUE_NAME,
	// Job data is untrusted at this boundary (anything could have been pushed to
	// Redis) — validate before acting on it.
	async (job) => {
		if (isJobStale(job.timestamp, maxJobAgeMs)) {
			logger.warn('Discarded stale queued job', {
				jobId: job.id,
				name: job.name,
				ageMs: Date.now() - job.timestamp,
				maxJobAgeMs,
			});
			return { status: 'no-trigger' } as const;
		}
		return await processJob(SwarmJobSchema.parse(job.data), registry, shutdown.signal);
	},
	{
		connection: parseRedisUrl(requireEnv('REDIS_URL')),
		concurrency,
		// Wide enough that an event-loop stall under concurrency can't slip a lock
		// renewal past the deadline and get the running phase reclaimed as stalled
		// (see SWARM_WORKER_LOCK_DURATION_MS above).
		lockDuration,
		lockRenewTime,
		// Agent runs aren't idempotent (see processJob's doc comment), so a job
		// interrupted by process death must fail visibly rather than be re-queued
		// by the stalled-job checker and silently re-run on restart. A stall that
		// slips through anyway is surfaced on the board by the `failed` handler
		// below (`reportInterruptedJobToBoard`) rather than vanishing into the log.
		maxStalledCount: 0,
	},
);

worker.on('completed', (job, outcome: JobOutcome) => {
	logger.debug('Job completed', { jobId: job.id, name: job.name, outcome });
	// A rate-limited or worker-aborted phase completes (from BullMQ's view) as
	// `phase-deferred`: re-enqueue it delayed so it retries once quota is back, or
	// once whatever restarted the worker mid-run has settled (issue #91; aborted
	// case added after a dev `--watch` restart permanently failed an in-flight
	// review). Done here, not in `processJob`, to keep the consumer
	// BullMQ-agnostic — the entrypoint owns the queue. Fire-and-forget with its
	// own error handling so a re-enqueue failure can't reject the completed-event
	// handler; the (small) window where a worker crash between completion and
	// re-enqueue loses the retry is an accepted MVP tradeoff.
	if (outcome?.status === 'phase-deferred') {
		void reenqueueDeferred(job.id, job.data, outcome);
	}
});

worker.on('failed', (job, err) => {
	logger.error('Job failed', { jobId: job?.id, name: job?.name, error: err.message });
	// A job reaches `failed` only outside `processJob` (which turns phase failures
	// into completed outcomes, never throws them): a stalled job the queue
	// reclaimed (`maxStalledCount: 0` → terminal, no retry) or the lone
	// unknown-project throw. The phase's own board-reporting never ran, so leave a
	// board-visible trace here. Fire-and-forget with its own error handling so a
	// comment failure can't reject the event handler; it no-ops when there's no
	// resolvable target (e.g. the unknown-project case).
	if (job?.data) {
		void reportInterruptedJobToBoard(job.data, err.message);
	}
});
// Connection-level errors (Redis down, …); BullMQ retries internally, but an
// unhandled 'error' event would crash the process.
worker.on('error', (err) => {
	logger.error('Worker queue error', { error: err.message });
});
worker.on('lockRenewalFailed', (jobIds) => {
	logger.error('Worker failed to renew active job locks', { jobIds });
});

// Subscribe to user-initiated run terminations from the dashboard (issue #166):
// when a cancellation for a run running in this worker arrives, abort its agent
// via the per-run controller registered in `processJob`. A notification for a run
// not currently executing here is a no-op — the durable set (checked at run
// start) covers that case.
const cancellationSubscription = subscribeToRunCancellations((runId) => {
	if (abortRun(runId)) {
		logger.info('Aborting run — user requested termination', { runId });
	}
});

logger.debug('swarm-worker started', { queue: QUEUE_NAME, concurrency });

async function runWorktreeSweep(): Promise<void> {
	try {
		logger.debug('Starting background worktree retention sweep');
		const projects = await listAllProjectsFromDb();
		for (const project of projects) {
			try {
				await pruneStaleWorktrees(project);
			} catch (err) {
				logger.error('Failed to run worktree retention sweep for project', {
					projectId: project.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	} catch (err) {
		logger.error('Failed to list projects for worktree retention sweep', {
			error: describeError(err),
		});
	}
}

// Run once immediately after startup
void runWorktreeSweep();

const sweepInterval = setInterval(() => {
	void runWorktreeSweep();
}, sweepIntervalMs);
sweepInterval.unref();

/**
 * Reconcile stale `running` rows while the worker keeps serving jobs (issue
 * #165) — the running-worker safety net the startup-only `failOrphanedRunningRuns`
 * can't provide. A row still `running` past `max(configured timeout) + grace` is
 * a phase whose process died without finalizing (the exact `dd0ad860-…` symptom:
 * the agent exited but the row stayed `running`), since every live agent is
 * killed at its own timeout — so it is safe to fail without touching a genuinely
 * in-flight run. Best-effort: a hiccup must not stop the worker serving jobs.
 */
async function runStaleRunSweep(): Promise<void> {
	try {
		const reconciled = await failStaleRunningRuns(
			agentTimeoutMs,
			STALE_RUN_MARGIN_MS,
			'Run exceeded its wall-clock timeout without finalizing — reconciled as stale',
		);
		if (reconciled > 0) {
			logger.warn('Reconciled stale running runs while serving jobs', {
				count: reconciled,
			});
		}
	} catch (err) {
		logger.error('Failed to reconcile stale running runs', { error: describeError(err) });
	}
}

const staleRunSweepInterval = setInterval(() => {
	void runStaleRunSweep();
}, staleRunSweepIntervalMs);
staleRunSweepInterval.unref();

const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const quotaDiscoveryInterval = setInterval(() => {
	void runQuotaDiscovery(true);
}, HEARTBEAT_INTERVAL_MS);
quotaDiscoveryInterval.unref();

// On shutdown (Ctrl+C sends SIGINT; a `kill`/supervisor sends SIGTERM), abort
// the in-flight agent run (it completes as `phase-failed`; each phase runs its
// own worktree cleanup in a `finally`), then let worker.close() wait for the
// job to finish before exiting.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		logger.debug(`Received ${signal} — aborting in-flight agent run and closing worker`);
		clearInterval(sweepInterval);
		clearInterval(staleRunSweepInterval);
		clearInterval(quotaDiscoveryInterval);
		shutdown.abort();
		void cancellationSubscription.close();
		void closeRunCancellationRedis();
		void worker.close().then(
			() => process.exit(0),
			(err) => {
				logger.error('Worker close failed', {
					error: err instanceof Error ? err.message : String(err),
				});
				process.exit(1);
			},
		);
	});
}
