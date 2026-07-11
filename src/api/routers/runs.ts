import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	listRunsFromDb,
} from '../../db/repositories/runsRepository.js';
import { promoteRetryForRun } from '../../queue/producer.js';
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
]);

const ListRunsInputSchema = z.object({
	projectId: z.string().min(1).optional(),
	status: RunStatusEnum.optional(),
	phase: RunPhaseEnum.optional(),
	limit: z.number().int().positive().max(200).default(50),
	offset: z.number().int().nonnegative().default(0),
});

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

	// Fire a deferred run's scheduled retry immediately ("Retry now", issue #136).
	//
	// Offered for `deferred` runs only: such a run always has a pending BullMQ
	// retry job carrying its `runId`, which `promoteRetryForRun` can locate and
	// promote (delay → 0). A `failed` run (its automatic budget exhausted) has
	// neither a pending job nor a persisted job payload to reconstruct one from,
	// so it isn't retryable here — and it doesn't need to be, because a manual
	// retry resets the promoted job's attempt counter, so a *deferred* run never
	// becomes un-retryable no matter how many times its automatic cap was hit.
	//
	// The `deferred`-only guard plus reusing that single pending job is also the
	// duplicate guard: a run already picked up is `running` (rejected here), and
	// there is only ever one job to promote, so a manual retry can't race the
	// automatic one into two concurrent runs.
	retryNow: publicProcedure
		.input(z.object({ runId: z.string().min(1) }))
		.mutation(async ({ input }) => {
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}
			if (run.status !== 'deferred') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Only a deferred run can be retried now; run "${input.runId}" is ${run.status}.`,
				});
			}

			const promoted = await promoteRetryForRun(input.runId);
			if (!promoted) {
				throw new TRPCError({
					code: 'CONFLICT',
					message:
						'No pending retry was found to promote — this run may already be retrying. Refresh and try again.',
				});
			}
			return { runId: input.runId, status: 'retrying' as const };
		}),
});
