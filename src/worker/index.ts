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
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import {
	failOrphanedRunningRuns,
	failStaleRunningRuns,
} from '../db/repositories/runsRepository.js';
import { optionalEnv, requireEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { addFileSink, configureLogger, logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { QUEUE_NAME, type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
import { enqueueDelayedRetry } from '../queue/producer.js';
import { createTriggerRegistry, registerBuiltInTriggers } from '../triggers/index.js';
import { pruneStaleWorktrees } from '../worktree/retention.js';
import {
	type JobOutcome,
	processJob,
	reportInterruptedJobToBoard,
	resolveAgentTimeoutMs,
} from './consumer.js';
import { resetProjectSlot } from './project-concurrency.js';

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

// BullMQ holds a per-job lock and renews it on a timer at ~half this interval
// while the phase runs. A phase is a multi-minute agent CLI run, so the lock is
// renewed many times over its life — the only thing this duration has to exceed
// is the worst-case gap *between* renewals, i.e. how long the single-threaded
// event loop can stall (two concurrent chatty agents saturating CPU, a GC
// pause, a Redis blip) before a renewal fires. BullMQ's 30s default is far too
// tight for that: a brief event-loop starvation slips one renewal past 30s, the
// lock expires, the stalled-checker reclaims the job, and — with
// `maxStalledCount: 0` — it fails outright with no retry, silently losing an
// in-flight review (observed live: PR review dropped when the lock could not be
// renewed). Default to 5 min of headroom; override via env for a heavier host.
const rawLockDuration = optionalEnv('SWARM_WORKER_LOCK_DURATION_MS', String(5 * 60 * 1000));
const lockDuration = Number(rawLockDuration);
if (!Number.isInteger(lockDuration) || lockDuration < 1) {
	throw new Error(
		`SWARM_WORKER_LOCK_DURATION_MS must be a positive integer, got '${rawLockDuration}'`,
	);
}

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

// Bring the DB schema up to date before serving any job. The `db:migrate` npm
// prefix runs only on the first `dev:worker` invocation; `tsx --watch` restarts
// (frequent — SWARM edits its own repo) skip it, so without this a restart onto
// newer schema-referencing code runs ahead of the DB and every `runs` write/read
// fails silently (run tracking is best-effort) — the phase runs but never shows
// in the dashboard. Fatal on failure: a schema-mismatched worker is the exact
// bug this guards against, so crash loudly rather than serve jobs blind.
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

const worker = new Worker(
	QUEUE_NAME,
	// Job data is untrusted at this boundary (anything could have been pushed to
	// Redis) — validate before acting on it.
	async (job) => processJob(SwarmJobSchema.parse(job.data), registry, shutdown.signal),
	{
		connection: parseRedisUrl(requireEnv('REDIS_URL')),
		concurrency,
		// Wide enough that an event-loop stall under concurrency can't slip a lock
		// renewal past the deadline and get the running phase reclaimed as stalled
		// (see SWARM_WORKER_LOCK_DURATION_MS above).
		lockDuration,
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

/**
 * Re-enqueue a deferred job (rate-limited or worker-aborted) with its retry
 * counter bumped, so the consumer can cap the loop. `data` is re-validated (it
 * round-trips through Redis) before the counter is incremented.
 */
async function reenqueueDeferred(
	jobId: string | undefined,
	data: unknown,
	outcome: Extract<JobOutcome, { status: 'phase-deferred' }>,
): Promise<void> {
	try {
		const parsed = SwarmJobSchema.parse(data);
		const next: SwarmJob = {
			...parsed,
			rateLimitRetryAttempt: (parsed.rateLimitRetryAttempt ?? 0) + 1,
			// Carry the originating run row forward (issue #136) so the retry resets
			// that same row instead of inserting a second one. `outcome.runId` wins
			// over any stale value on `parsed` (they match on a retry; only the
			// outcome knows the row a fresh webhook's first run just created).
			...(outcome.runId ? { runId: outcome.runId } : {}),
			...(parsed.type === 'github-projects' &&
			(outcome.phase === 'planning' || outcome.phase === 'implementation')
				? { resumePmPhase: outcome.phase }
				: {}),
		};
		await enqueueDelayedRetry(next, outcome.retryDelayMs);
		logger.debug('Rate-limited phase re-enqueued for retry', {
			jobId,
			phase: outcome.phase,
			taskId: outcome.taskId,
			retryDelayMs: outcome.retryDelayMs,
			attempt: next.rateLimitRetryAttempt,
		});
	} catch (err) {
		logger.error('Failed to re-enqueue rate-limited phase', {
			jobId,
			taskId: outcome.taskId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
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

// On shutdown (Ctrl+C sends SIGINT; a `kill`/supervisor sends SIGTERM), abort
// the in-flight agent run (it completes as `phase-failed`; each phase runs its
// own worktree cleanup in a `finally`), then let worker.close() wait for the
// job to finish before exiting.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		logger.debug(`Received ${signal} — aborting in-flight agent run and closing worker`);
		clearInterval(sweepInterval);
		clearInterval(staleRunSweepInterval);
		shutdown.abort();
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
