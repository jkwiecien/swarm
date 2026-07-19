import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '../../db/repositories/credentialsRepository.js';
import { getProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { publicProcedure, router } from '../trpc.js';

/**
 * Project-scoped credentials API — mirrors Cascade's `projectsRouter.credentials`
 * (`cascade/src/api/routers/projects.ts`). `list` never returns plaintext, only a
 * masked preview; SWARM has no org/ownership layer to check (single-user,
 * `DASHBOARD_TOKEN` bearer auth guards the whole `/trpc` surface), so each
 * procedure does a plain `getProjectByIdFromDb` existence check instead of
 * Cascade's `verifyProjectOwnership`.
 */

/**
 * Never returns plaintext or any substring of it — a configured credential
 * always collapses to the same fixed opaque marker regardless of its length,
 * so the response discloses only configured/not-configured state.
 */
function maskCredential(value: string | undefined): string {
	return value === undefined ? 'not set' : '****';
}

export const credentialsRouter = router({
	list: publicProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ input }) => {
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			const resolved = await resolveAllProjectCredentials(input.projectId);

			return Object.entries(project.credentials).map(([role, envVarKey]) => ({
				role: role as 'implementer' | 'reviewer' | 'webhookSecret',
				envVarKey,
				isConfigured: envVarKey in resolved,
				maskedValue: maskCredential(resolved[envVarKey]),
			}));
		}),

	set: publicProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				envVarKey: z
					.string()
					.regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an UPPER_SNAKE_CASE env var key'),
				value: z.string().min(1),
				name: z.string().optional(),
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

			await writeProjectCredential(
				input.projectId,
				input.envVarKey,
				input.value,
				input.name ?? null,
			);
		}),

	delete: publicProcedure
		.input(z.object({ projectId: z.string().min(1), envVarKey: z.string().min(1) }))
		.mutation(async ({ input }) => {
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			await deleteProjectCredential(input.projectId, input.envVarKey);
		}),
});
