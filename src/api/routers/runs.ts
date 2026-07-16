import { TRPCError } from '@trpc/server';
import { z } from 'zod';

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
import {
	clearRunCancellation,
	requestRunCancellation,
	USER_TERMINATION_MESSAGE,
} from '../../queue/cancellation.js';
import {
	enqueueDelayedRetry,
	promoteRetryForRun,
	removePendingRetryForRun,
} from '../../queue/producer.js';
import { publicProcedure, router } from '../trpc.js';

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
): Promise<void> {
	if (await resetRunToRunning(runId, jobPayload, fromStatus, model, undefined, reasoning, engine))
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
	return job;
}

export const runsRouter = router({
	// Paginated, filtered list; returns { data, total } straight from the repo.
	list: publicProcedure.input(ListRunsInputSchema).query(async ({ input }) => {
		return await listRunsFromDb(input);
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
				// Atomic claim (deferred → running); CONFLICT if a concurrent retry or
				// the automatic pickup already flipped it — the real duplicate guard.
				await claimRunOrThrow(
					run.id,
					undefined,
					'deferred',
					input.model,
					reasoningForRow,
					engineForRow,
				);
				// Common case: promote the pending delayed job in place (delay → 0).
				const promoted = await promoteRetryForRun(
					input.runId,
					input.cli,
					input.model,
					input.reasoning,
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
			);
			await claimRunOrThrow(run.id, job, 'failed', input.model, reasoningForRow, engineForRow);
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
				// Cancel the pending retry job so no automatic pickup resurrects it,
				// then atomically fail the row while it's still deferred.
				await removePendingRetryForRun(run.id);
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
});
