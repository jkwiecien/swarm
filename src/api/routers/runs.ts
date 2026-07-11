import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	listRunsFromDb,
	resetRunToRunning,
} from '../../db/repositories/runsRepository.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { enqueueDelayedRetry, promoteRetryForRun } from '../../queue/producer.js';
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
): Promise<void> {
	if (await resetRunToRunning(runId, jobPayload, fromStatus, model)) return;
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
	cli?: z.infer<typeof AgentCliSchema>,
	model?: string,
): NonNullable<Parameters<typeof resetRunToRunning>[1]> {
	const job = { ...jobPayload };
	job.runId = runId;
	job.rateLimitRetryAttempt = 0;
	if (cli) job.cliOverride = cli;
	if (model) job.modelOverride = model;
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

			if (run.status === 'deferred') {
				// Atomic claim (deferred → running); CONFLICT if a concurrent retry or
				// the automatic pickup already flipped it — the real duplicate guard.
				await claimRunOrThrow(run.id, undefined, 'deferred', input.model);
				// Common case: promote the pending delayed job in place (delay → 0).
				const promoted = await promoteRetryForRun(input.runId, input.cli, input.model);
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
				const job = reconstructRetryJob(run.jobPayload, run.id, input.cli, input.model);
				// Persist the reconstructed payload onto the already-claimed row, then
				// enqueue at delay 0.
				await resetRunToRunning(run.id, job, undefined, input.model);
				await enqueueDelayedRetry(job, 0);
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
			const job = reconstructRetryJob(run.jobPayload, run.id, input.cli, input.model);
			await claimRunOrThrow(run.id, job, 'failed', input.model);
			await enqueueDelayedRetry(job, 0);

			return { runId: input.runId, status: 'retrying' as const };
		}),
});
