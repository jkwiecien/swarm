import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	getActiveDispatchByRunId,
	getDispatchById,
	listWaitingDispatches,
	reopenDispatchForManualRetry,
} from '../../db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
	listRunsFromDb,
	markRunUserTerminated,
} from '../../db/repositories/runsRepository.js';
import {
	cancelDispatchAndWake,
	cancelDispatchForRun,
	createAndPublishDispatch,
	publishDispatchWakeUp,
} from '../../dispatch/dispatcher.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../../harness/models.js';
import { resolvePipelinePhaseForOptionId } from '../../integrations/pm/github-projects/status-mapping.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
import { describeError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
	clearRunCancellation,
	RUN_CANCELLED_MESSAGE,
	requestRunCancellation,
} from '../../queue/cancellation.js';
import { type SwarmJob, SwarmJobSchema } from '../../queue/jobs.js';
import { priorityFor } from '../../queue/producer.js';
import {
	deriveQueuedPhaseHint,
	type QueuedPhaseHint,
	type QueuedRun,
	toQueuedRuns,
} from '../../queue/queued-runs.js';
import type { TriggerPhase } from '../../triggers/types.js';
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

/**
 * Rebuild a retry job payload from a stored one: carry the originating `runId`
 * forward (so the retry reuses that row) and reset the rate-limit attempt
 * counter to 0 (a manual retry bypasses the automatic cap), applying any
 * cli/model overrides. Shared by the reopen-existing-dispatch path and the
 * reconstruct-from-run-row fallback.
 */
function reconstructRetryJob(
	jobPayload: SwarmJob,
	runId: string,
	phase: string,
	cli?: z.infer<typeof AgentCliSchema>,
	model?: string,
	reasoning?: z.infer<typeof ReasoningLevelSchema>,
	freshSession = false,
): SwarmJob {
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

function alreadyRetrying(): TRPCError {
	return new TRPCError({
		code: 'CONFLICT',
		message: 'This run is already retrying. Refresh to see its current status.',
	});
}

export const runsRouter = router({
	// Paginated, filtered list; returns { data, total } straight from the repo.
	list: publicProcedure.input(ListRunsInputSchema).query(async ({ input }) => {
		return await listRunsFromDb(input);
	}),

	// Every canonical waiting dispatch (pending / capacity-blocked /
	// retry-scheduled) — the durable queue read model (issues #234, #284), never
	// a BullMQ snapshot, so nothing pending can be invisible here. No pagination:
	// the pending set is small and bounded by worker throughput.
	queued: publicProcedure
		.input(z.object({ projectId: z.string().min(1).optional() }).optional())
		.query(async ({ input }) => {
			const items = toQueuedRuns(await listWaitingDispatches(input?.projectId));
			return enrichQueuedWorkItems(items);
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

	// Fire a run's retry immediately ("Retry now", issues #136, #284).
	//
	// Scope: `deferred` or terminally `failed` runs. The retry is a *dispatch*
	// transition, never a direct run-row flip: the run stays `deferred`/`failed`
	// until the worker actually claims the dispatch and starts the attempt, so a
	// failed enqueue can no longer strand a false `running` run (the exact
	// orphan issue #284 calls out). Two shapes:
	//
	//  1. The run has an active dispatch (`retry-scheduled`, or capacity-blocked
	//     `pending`) — the common case. Its stored payload gets the operator's
	//     overrides folded in and the dispatch is atomically re-opened for an
	//     immediate attempt (`reopenDispatchForManualRetry`); losing that
	//     conditional update to a concurrent pickup returns CONFLICT.
	//  2. No active dispatch (a terminally `failed` run, or a legacy row whose
	//     retry intent was lost) — reconstruct from the run's stored
	//     `jobPayload` and create a fresh dispatch. The one-active-dispatch-per-
	//     run unique index turns a double-click into CONFLICT, not two runs.
	//
	// Cap-bypass: every path resets `rateLimitRetryAttempt` to 0, so a manual
	// retry always gets a fresh budget — including a run whose next *automatic*
	// attempt would itself have tripped `MAX_RATE_LIMIT_RETRIES`.
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

			const applyingOverride =
				input.cli !== undefined || input.model !== undefined || input.reasoning !== undefined;
			const startFresh = run.status === 'failed' || run.agentSessionId === null || applyingOverride;

			const active = await getActiveDispatchByRunId(run.id);
			if (active) {
				// Fold the overrides into the dispatch's stored payload (authoritative
				// at claim time) and re-open it for an immediate attempt.
				const stored = SwarmJobSchema.safeParse(active.jobPayload);
				if (!stored.success) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Cannot retry run "${input.runId}" — its dispatch payload no longer validates.`,
					});
				}
				const job = reconstructRetryJob(
					stored.data,
					run.id,
					run.phase,
					input.cli,
					input.model,
					input.reasoning,
					startFresh,
				);
				const reopened = await reopenDispatchForManualRetry(active.id, job);
				if (!reopened) throw alreadyRetrying();
				try {
					await publishDispatchWakeUp(reopened);
				} catch (err) {
					// The durable intent is already recorded; the reconciler re-publishes.
					logger.warn('retryNow: failed to publish wake-up (reconciler will repair)', {
						dispatchId: reopened.id,
						error: describeError(err),
					});
				}
				return { runId: input.runId, status: 'retrying' as const };
			}

			// No active dispatch — reconstruct from the run row's stored payload.
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
			try {
				await createAndPublishDispatch({
					projectId: run.projectId,
					jobPayload: job,
					priority: priorityFor(job) ?? 0,
					source: 'manual',
					waitReason: 'manual-retry',
					runId: run.id,
					taskId: run.taskId,
					phase: run.phase as TriggerPhase,
				});
			} catch (err) {
				const message = describeError(err);
				// The one-active-dispatch-per-run unique index: a concurrent retry won.
				if (message.includes('uq_dispatches_active_run') || message.includes('duplicate key')) {
					throw alreadyRetrying();
				}
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to create the retry dispatch: ${message}`,
				});
			}

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
				// Cancel the canonical dispatch first (issue #284): a cancelled
				// dispatch refuses every future claim — a late retry wake-up, a slot
				// release, or reconciliation — so nothing can resurrect this run.
				// Then atomically fail the row while it's still deferred.
				await cancelDispatchForRun(run.id, RUN_CANCELLED_MESSAGE);
				if (await markRunUserTerminated(run.id, RUN_CANCELLED_MESSAGE, 'deferred')) {
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

	// Put back action for queued work items (issues #251, #284).
	// Cancels a waiting dispatch (the canonical record — nothing can resurrect
	// it afterwards) and moves its linked card back to backlog.
	putBack: publicProcedure
		.input(
			z.object({
				/** The dispatch id shown by `runs.queued` as `jobId`. */
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

			const dispatch = await getDispatchById(input.jobId);
			if (!dispatch) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Queued dispatch with ID "${input.jobId}" not found`,
				});
			}
			if (dispatch.state !== 'pending' && dispatch.state !== 'retry-scheduled') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Dispatch "${input.jobId}" is ${dispatch.state} and cannot be put back.`,
				});
			}
			const parsedJob = SwarmJobSchema.safeParse(dispatch.jobPayload);
			if (!parsedJob.success) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Dispatch "${input.jobId}" has an invalid stored payload.`,
				});
			}
			const jobData: SwarmJob = parsedJob.data;

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

			// Cancel the canonical dispatch *before* moving the card: once cancelled,
			// no wake-up or reconciliation can start the phase, so the card move can
			// never race a pickup. Losing the conditional cancel means a worker
			// claimed it in the meantime — surface that instead of moving the card
			// out from under a starting run.
			const cancelled = await cancelDispatchAndWake(
				dispatch.id,
				'Put back to Backlog from the dashboard',
			);
			if (!cancelled) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Dispatch "${input.jobId}" was picked up while putting it back — refresh to see its run.`,
				});
			}

			try {
				await pm.moveWorkItem(workItemNodeId, 'backlog');
			} catch (error) {
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Dispatch cancelled, but moving the board card to backlog failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}

			return { success: true };
		}),
});
