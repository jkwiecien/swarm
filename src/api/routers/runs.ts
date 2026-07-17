import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { getProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
	listRunsFromDb,
	markRunUserTerminated,
	resetRunToRunning,
} from '../../db/repositories/runsRepository.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../../harness/models.js';
import { resolvePipelinePhaseForOptionId } from '../../integrations/pm/github-projects/status-mapping.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
import { logger } from '../../lib/logger.js';
import {
	clearRunCancellation,
	requestRunCancellation,
	USER_TERMINATION_MESSAGE,
} from '../../queue/cancellation.js';
import type { SwarmJob } from '../../queue/jobs.js';
import {
	enqueueDelayedRetry,
	getQueuedJobData,
	listPendingJobs,
	promoteRetryForRun,
	removePendingRetryForRun,
	removeQueuedJob,
} from '../../queue/producer.js';
import {
	deriveQueuedPhaseHint,
	type QueuedPhaseHint,
	type QueuedRun,
	toQueuedRuns,
} from '../../queue/queued-runs.js';
import { removePendingContinuationForRun } from '../../worker/pending-continuations.js';
import { publicProcedure, router } from '../trpc.js';

const QUEUED_WORK_ITEM_CACHE_TTL_MS = 30_000;
const queuedWorkItemCache = new Map<
	string,
	{ expiresAt: number; title?: string; url?: string; nodeId?: string; phaseHint?: QueuedPhaseHint }
>();

function queuedWorkItemCacheKey(item: QueuedRun): string | null {
	if (item.type === 'github-projects' && item.workItemNodeId) {
		return `${item.projectId}:${item.workItemNodeId}`;
	}
	if (item.type === 'github' && item.prNumber) {
		return `${item.projectId}:github:${item.prNumber}`;
	}
	return null;
}

function withQueuedWorkItemDetails(
	item: QueuedRun,
	details: { title?: string; url?: string; nodeId?: string; phaseHint?: QueuedPhaseHint },
): QueuedRun {
	return {
		...item,
		workItemTitle: details.title,
		workItemUrl: details.url,
		workItemNodeId: details.nodeId || item.workItemNodeId,
		phaseHint: details.phaseHint || item.phaseHint,
	};
}

async function resolveQueuedWorkItemDetails(
	item: QueuedRun,
	workItemNodeId: string,
): Promise<{ title?: string; url?: string; isSupported?: boolean } | null> {
	const project = await getProjectByIdFromDb(item.projectId);
	if (!project) return null;

	const manifest = getPMProvider(project.pm.type);
	if (!manifest) return null;

	const workItem = await manifest.createProvider(project).getWorkItem(workItemNodeId);
	let isSupported = false;
	if (workItem.statusId) {
		const targetPhase = resolvePipelinePhaseForOptionId(project.githubProjects, workItem.statusId);
		if (targetPhase === 'planning' || targetPhase === 'implementation') {
			isSupported = true;
		}
	}
	return {
		title: workItem.title || undefined,
		url: workItem.url || undefined,
		isSupported,
	};
}

async function enrichQueuedWorkItem(item: QueuedRun): Promise<QueuedRun> {
	const cacheKey = queuedWorkItemCacheKey(item);
	if (!cacheKey) return item;

	const cached = queuedWorkItemCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return withQueuedWorkItemDetails(item, cached);
	}

	try {
		let details: {
			title?: string;
			url?: string;
			nodeId?: string;
			phaseHint?: QueuedPhaseHint;
		} | null = null;
		if (item.type === 'github-projects' && item.workItemNodeId) {
			const resolved = await resolveQueuedWorkItemDetails(item, item.workItemNodeId);
			if (resolved) {
				details = {
					title: resolved.title,
					url: resolved.url,
					nodeId: item.workItemNodeId,
					phaseHint: resolved.isSupported ? 'board' : 'unknown',
				};
			}
		} else if (item.type === 'github' && item.prNumber) {
			const project = await getProjectByIdFromDb(item.projectId);
			if (project) {
				const manifest = getPMProvider(project.pm.type);
				if (manifest) {
					const pm = manifest.createProvider(project);
					const items = await pm.listWorkItems();
					const repoFullName = item.repo;
					const match = items.find((i) =>
						repoFullName
							? i.url.endsWith(`/${repoFullName}/issues/${item.prNumber}`) ||
								i.url.endsWith(`/${repoFullName}/pull/${item.prNumber}`)
							: i.url.endsWith(`/issues/${item.prNumber}`) ||
								i.url.endsWith(`/pull/${item.prNumber}`),
					);
					if (match) {
						details = {
							title: match.title || undefined,
							url: match.url || undefined,
							nodeId: match.id,
						};
					}
				}
			}
		}

		if (!details) return item;

		const cachedDetails = {
			expiresAt: Date.now() + QUEUED_WORK_ITEM_CACHE_TTL_MS,
			...details,
		};
		queuedWorkItemCache.set(cacheKey, cachedDetails);
		return withQueuedWorkItemDetails(item, cachedDetails);
	} catch (error) {
		logger.debug('runs.queued: backing work item lookup failed; using fallback', {
			projectId: item.projectId,
			workItemNodeId: item.workItemNodeId,
			prNumber: item.prNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return item;
	}
}

/** Add the same backing Issue/PR metadata that the persisted runs list uses. */
async function enrichQueuedWorkItems(items: QueuedRun[]): Promise<QueuedRun[]> {
	return Promise.all(items.map(enrichQueuedWorkItem));
}

// `RunStatus`/`RunRow` are local (non-exported) types in the repository, so the
// router declares its own filter enums — keeping Zod the source of truth for the
// API boundary and rejecting garbage filter values before they reach the DB.
const RunStatusEnum = z.enum(['running', 'completed', 'failed', 'deferred']);
const RunPhaseEnum = z.enum([
	'planning',
	'implementation',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);

const ListRunsInputSchema = z.object({
	projectId: z.string().min(1).optional(),
	status: RunStatusEnum.optional(),
	phase: RunPhaseEnum.optional(),
	limit: z.number().int().positive().max(200).default(50),
	offset: z.number().int().nonnegative().default(0),
});

async function claimRunOrThrow(
	runId: string,
	jobPayload: Parameters<typeof resetRunToRunning>[1],
	fromStatus: 'deferred' | 'failed',
	model?: string,
	reasoning?: string | null,
	engine?: z.infer<typeof AgentCliSchema>,
	agentSessionId?: string | null,
): Promise<void> {
	if (
		await resetRunToRunning(
			runId,
			jobPayload,
			fromStatus,
			model,
			undefined,
			reasoning,
			engine,
			agentSessionId,
		)
	)
		return;
	throw new TRPCError({
		code: 'CONFLICT',
		message: 'This run is already retrying. Refresh to see its current status.',
	});
}

/**
 * Rebuild a fresh retry job from a run's stored payload: carry the originating
 * `runId` forward (so the retry reuses that row) and reset the rate-limit
 * attempt counter to 0 (a manual retry bypasses the automatic cap), applying any
 * cli/model overrides. Shared by the terminally-`failed` path and the
 * lost-pending-job fallback on the `deferred` path.
 */
function reconstructRetryJob(
	jobPayload: NonNullable<Parameters<typeof resetRunToRunning>[1]>,
	runId: string,
	phase: string,
	cli?: z.infer<typeof AgentCliSchema>,
	model?: string,
	reasoning?: z.infer<typeof ReasoningLevelSchema>,
	freshSession = false,
): NonNullable<Parameters<typeof resetRunToRunning>[1]> {
	const job = { ...jobPayload };
	job.runId = runId;
	job.rateLimitRetryAttempt = 0;
	if (job.type === 'github-projects' && (phase === 'planning' || phase === 'implementation')) {
		job.resumePmPhase = phase;
	}
	if (cli) job.cliOverride = cli;
	if (model) job.modelOverride = model;
	if (reasoning) job.reasoningOverride = reasoning;
	if (freshSession) {
		job.agentSessionId = randomUUID();
		delete job.resumeSession;
	}
	return job;
}

export const runsRouter = router({
	// Paginated, filtered list; returns { data, total } straight from the repo.
	list: publicProcedure.input(ListRunsInputSchema).query(async ({ input }) => {
		return await listRunsFromDb(input);
	}),

	// Work enqueued in BullMQ but not yet picked up by the worker — invisible to
	// `list` above, which only reads the `runs` table (issue #234). No pagination:
	// the pending set is small and bounded by worker throughput.
	queued: publicProcedure
		.input(z.object({ projectId: z.string().min(1).optional() }).optional())
		.query(async ({ input }) => {
			const items = toQueuedRuns(await listPendingJobs());
			const scoped = input?.projectId
				? items.filter((item) => item.projectId === input.projectId)
				: items;
			return enrichQueuedWorkItems(scoped);
		}),

	// Single run by id; NOT_FOUND when unknown (the only not-found path).
	getById: publicProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input }) => {
		const run = await getRunByIdFromDb(input.id);
		if (!run) {
			throw new TRPCError({
				code: 'NOT_FOUND',
				message: `Run with ID "${input.id}" not found`,
			});
		}
		return run;
	}),

	// Captured stdout/stderr for a run; null when the run stored no logs (a run
	// that succeeded, or failed before its output was captured) — not an error.
	getLogs: publicProcedure
		.input(z.object({ runId: z.string().min(1) }))
		.query(async ({ input }) => {
			return (await getRunLogsFromDb(input.runId)) ?? null;
		}),

	getOutput: publicProcedure
		.input(z.object({ runId: z.string().min(1), after: z.number().int().nonnegative().default(0) }))
		.query(async ({ input }) => await getRunOutputEvents(input.runId, input.after)),

	// Fire a run's retry immediately ("Retry now", issue #136).
	//
	// Scope: `deferred` or terminally `failed` runs. The duplicate guard is the
	// atomic `claimRunOrThrow` (a conditional `deferred|failed → running` update):
	// whichever caller flips the row wins, and a concurrent manual retry or the
	// automatic pickup gets a CONFLICT — so two concurrent runs can't start.
	//
	// After claiming, three shapes reach the same end (a fresh run at delay 0):
	//
	//  1. `deferred` with its pending retry still in Redis — the common case: one
	//     delayed BullMQ job carries this `runId`; `promoteRetryForRun` promotes it
	//     (delay → 0).
	//  2. `deferred` but the pending job was lost — the re-enqueue never landed (the
	//     fire-and-forget window on worker shutdown, or the completed job reaped
	//     from Redis; see `reenqueueDeferred` in `src/worker/index.ts`). Promotion
	//     finds nothing, so we reconstruct from the stored `jobPayload` and enqueue,
	//     reusing the claim we already hold — instead of the dead-end CONFLICT this
	//     used to return.
	//  3. terminally `failed` (every automatic attempt consumed) — no pending job
	//     ever survives; reconstruct from `jobPayload` and claim atomically.
	//
	// Cap-bypass covers the *entire* deferred window: every path resets
	// `rateLimitRetryAttempt` to 0 before firing, so a manual retry always gets a
	// fresh budget — including a run whose next *automatic* attempt would itself
	// have tripped `MAX_RATE_LIMIT_RETRIES`. Thus a run stays manually retryable
	// for the whole time it is `deferred`, satisfying issue #136's "manual retry
	// remains available after the [automatic] cap is reached".
	//
	// Only limit: reconstruction needs a stored `jobPayload`. A run recorded
	// without one (older rows, or a create path that didn't persist it) can't be
	// rebuilt and is rejected with a clear message.
	retryNow: publicProcedure
		.input(
			z.object({
				runId: z.string().min(1),
				cli: AgentCliSchema.optional(),
				model: z.string().min(1).optional(),
				reasoning: ReasoningLevelSchema.optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}
			if (run.status !== 'deferred' && run.status !== 'failed') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Only a deferred or failed run can be retried; run "${input.runId}" is ${run.status}.`,
				});
			}

			// Clear any stale user-termination flag before re-running this row: a run
			// terminated while deferred keeps its cancellation entry (issue #166), and
			// re-running reuses the same immutable run id — without this the worker's
			// start-check would instantly terminate the fresh attempt.
			await clearRunCancellation(input.runId);

			// Reasoning to persist on the row (issue #180). When the retry dialog
			// applies an override (it always sends an explicit `cli`+`model`, and
			// `reasoning` is authoritative — an omitted level means "Default"), coerce a
			// missing level to `null` so a stale level is CLEARED rather than left in
			// place; otherwise the row would keep an old reasoning that no longer
			// matches the relaunch (`resetRunToRunning` treats `undefined` as
			// "leave as-is"). A plain "Retry now" with no override at all leaves the
			// column untouched (`undefined`). The worker re-resolves and resets the
			// carried row on pickup, but this keeps the row consistent in the meantime.
			const applyingOverride =
				input.cli !== undefined || input.model !== undefined || input.reasoning !== undefined;
			const reasoningForRow = applyingOverride ? (input.reasoning ?? null) : undefined;

			// Engine to persist on the row (issue #169). The retry dialog sends an
			// explicit `cli` whenever it applies an override, so recording `input.cli`
			// makes an override CLI visible the instant the row flips to `running`
			// rather than waiting for the worker to re-resolve it on pickup. A plain
			// "Retry now" sends no `cli` (`undefined`), so the column clears and the
			// worker's own reset repopulates the effective CLI when it picks the job up.
			const engineForRow = input.cli;

			if (run.status === 'deferred') {
				const startFresh = run.agentSessionId === null || applyingOverride;
				// Atomic claim (deferred → running); CONFLICT if a concurrent retry or
				// the automatic pickup already flipped it — the real duplicate guard.
				await claimRunOrThrow(
					run.id,
					undefined,
					'deferred',
					input.model,
					reasoningForRow,
					engineForRow,
					startFresh ? null : undefined,
				);
				// Common case: promote the pending delayed job in place (delay → 0).
				const promoted = await promoteRetryForRun(
					input.runId,
					input.cli,
					input.model,
					input.reasoning,
					startFresh,
				);
				if (promoted) {
					return { runId: input.runId, status: 'retrying' as const };
				}
				// No pending job to promote — the re-enqueue was lost (the
				// fire-and-forget window on worker shutdown, or the completed job reaped
				// from Redis; see `reenqueueDeferred` in `src/worker/index.ts`). Fall
				// through to reconstruct from the stored payload, exactly as the
				// terminally-`failed` path does. We already hold the claim (the row is
				// now `running`), so no second claim is needed — but a run with no stored
				// payload can't be rebuilt.
				if (!run.jobPayload) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Cannot retry run "${input.runId}" — it was created without a job payload.`,
					});
				}
				const job = reconstructRetryJob(
					run.jobPayload,
					run.id,
					run.phase,
					input.cli,
					input.model,
					input.reasoning,
					startFresh,
				);
				// Persist the reconstructed payload onto the already-claimed row, then
				// enqueue at delay 0.
				await resetRunToRunning(
					run.id,
					job,
					undefined,
					input.model,
					undefined,
					reasoningForRow,
					engineForRow,
					startFresh ? null : undefined,
				);
				await enqueueDelayedRetry(job, 0, { unique: true });
				return { runId: input.runId, status: 'retrying' as const };
			}

			// Terminally `failed` — no pending job ever survives; reconstruct from the
			// stored payload and claim atomically (failed → running).
			if (!run.jobPayload) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Cannot retry failed run "${input.runId}" — it was created without a job payload.`,
				});
			}
			const job = reconstructRetryJob(
				run.jobPayload,
				run.id,
				run.phase,
				input.cli,
				input.model,
				input.reasoning,
				true,
			);
			await claimRunOrThrow(
				run.id,
				job,
				'failed',
				input.model,
				reasoningForRow,
				engineForRow,
				null,
			);
			await enqueueDelayedRetry(job, 0, { unique: true });

			return { runId: input.runId, status: 'retrying' as const };
		}),

	// Terminate a running or deferred run ("Terminate", issue #166).
	//
	// The dashboard and worker are separate processes, so this never touches a
	// PID: it records a durable, run-id-keyed cancellation request in Redis
	// (`requestRunCancellation`) and notifies the worker, then handles the two
	// live states:
	//
	//  - `running`: the worker is executing the agent. The published notification
	//    (and, failing that, the worker's own start-check against the durable set)
	//    aborts the run via its `AbortSignal`, and the phase settles the row as
	//    `failed` with the user-termination reason. We don't write the row here —
	//    the worker owns an in-flight run's terminal state — so we report
	//    `terminating` and let the UI poll for the settle.
	//
	//  - `deferred`: no agent is running; a delayed BullMQ retry job is waiting.
	//    Remove that job so nothing resurrects the run, then atomically flip the
	//    row `deferred → failed`. If that conditional loses to a concurrent
	//    automatic pickup (the row is now `running`), we fall through to the
	//    running case — the flag we already set makes the worker terminate it.
	//
	// Idempotent and race-safe: a run that already settled (`completed`/`failed`)
	// returns its current state rather than erroring, so a second click or a
	// settle-during-terminate can't terminate a different run or double-act.
	// Keyed on the immutable run id, so a later retry of the same task is never
	// caught by this request.
	terminate: publicProcedure
		.input(z.object({ runId: z.string().min(1) }))
		.mutation(async ({ input }) => {
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}

			// Already terminal — nothing to terminate; report its settled state so a
			// second click (or a run that finished as we clicked) is a no-op, not an
			// error. Only `running`/`deferred` runs are actionable.
			if (run.status === 'completed' || run.status === 'failed') {
				return { runId: run.id, status: run.status };
			}

			// Durably record the intent and notify the worker before doing anything
			// else, so a pickup that races the branches below still sees it.
			await requestRunCancellation(run.id);

			if (run.status === 'deferred') {
				// Cancel either scheduled retry-shaped work or a slot-release pending
				// dispatch so no automatic pickup resurrects it,
				// then atomically fail the row while it's still deferred.
				await removePendingRetryForRun(run.id);
				await removePendingContinuationForRun(run.id);
				if (await markRunUserTerminated(run.id, USER_TERMINATION_MESSAGE, 'deferred')) {
					// Keep the durable marker until an explicit retry clears it. The
					// completed handler can still be between persisting `deferred` and
					// enqueueing its retry; it uses this marker to remove a late retry.
					return { runId: run.id, status: 'failed' as const };
				}
				// Lost the race: a worker picked the retry up between our read and the
				// conditional flip (the row is now `running`, or already settled).
				// Report its current state — the flag we set drives the worker to
				// terminate it if it's running.
				const latest = await getRunByIdFromDb(run.id);
				if (latest && (latest.status === 'failed' || latest.status === 'completed')) {
					return { runId: run.id, status: latest.status };
				}
				return { runId: run.id, status: 'terminating' as const };
			}

			// `running`: the worker aborts the agent and settles the row.
			return { runId: run.id, status: 'terminating' as const };
		}),

	// Put back action for queued work items (issue #251).
	// Safely removes a waiting, prioritized, or delayed job and moves its linked card back to backlog.
	putBack: publicProcedure
		.input(
			z.object({
				jobId: z.string().min(1),
				projectId: z.string().min(1),
			}),
		)
		.mutation(async ({ input }) => {
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			let jobData: SwarmJob;
			try {
				jobData = await getQueuedJobData(input.jobId);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: msg.includes('not found') ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
					message: msg,
				});
			}

			const phaseHint = deriveQueuedPhaseHint(jobData);
			if (phaseHint !== 'board' && phaseHint !== 'review') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Job phase hint "${phaseHint}" is not supported for Put back.`,
				});
			}

			let workItemNodeId: string | undefined;
			const pmManifest = getPMProvider(project.pm.type);
			if (!pmManifest) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `PM Provider for type "${project.pm.type}" not found`,
				});
			}
			const pm = pmManifest.createProvider(project);

			if (jobData.type === 'github-projects') {
				workItemNodeId = jobData.event.itemNodeId;
				const workItem = await pm.getWorkItem(workItemNodeId);
				if (!workItem.statusId) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Work item has no status ID.`,
					});
				}
				const targetPhase = resolvePipelinePhaseForOptionId(
					project.githubProjects,
					workItem.statusId,
				);
				if (!targetPhase) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Work item status does not start a Planning or Implementation phase.`,
					});
				}
			} else if (jobData.type === 'github') {
				const prNumber = jobData.event.workItemId;
				const repoFullName = jobData.event.repoFullName;
				if (prNumber && repoFullName) {
					const items = await pm.listWorkItems();
					const match = items.find(
						(item) =>
							item.url.endsWith(`/${repoFullName}/issues/${prNumber}`) ||
							item.url.endsWith(`/${repoFullName}/pull/${prNumber}`),
					);
					workItemNodeId = match?.id;
				}
			}

			if (!workItemNodeId) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Job has no linked board card.`,
				});
			}

			try {
				await pm.moveWorkItem(workItemNodeId, 'backlog');
			} catch (error) {
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to move board card to backlog: ${error instanceof Error ? error.message : String(error)}`,
				});
			}

			try {
				await removeQueuedJob(input.jobId);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to remove job from queue after moving board card: ${msg}`,
				});
			}

			return { success: true };
		}),
});
