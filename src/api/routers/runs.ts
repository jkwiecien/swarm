import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	getRunByIdFromDb,
	getRunLogsFromDb,
	listRunsFromDb,
} from '../../db/repositories/runsRepository.js';
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
});
