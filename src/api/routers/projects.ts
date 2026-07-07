import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ProjectConfigSchema } from '../../config/schema.js';
import {
	createProjectInDb,
	deleteProjectFromDb,
	getProjectByIdFromDb,
	listAllProjectsFromDb,
	upsertProjectToDb,
} from '../../db/repositories/projectsRepository.js';
import { publicProcedure, router } from '../trpc.js';

const DEFAULT_CREDENTIAL_REFERENCES = {
	implementer: 'GITHUB_TOKEN_IMPLEMENTER',
	reviewer: 'GITHUB_TOKEN_REVIEWER',
	webhookSecret: 'GITHUB_WEBHOOK_SECRET',
};

const ProjectWriteInputSchema = ProjectConfigSchema.omit({ credentials: true });

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && 'code' in error && (error as { code: string }).code === '23505';
}

export const projectsRouter = router({
	list: publicProcedure.query(async () => {
		return await listAllProjectsFromDb();
	}),

	getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
		const project = await getProjectByIdFromDb(input.id);
		if (!project) {
			throw new TRPCError({
				code: 'NOT_FOUND',
				message: `Project with ID "${input.id}" not found`,
			});
		}
		return project;
	}),

	create: publicProcedure.input(ProjectWriteInputSchema).mutation(async ({ input }) => {
		const config = {
			...input,
			credentials: DEFAULT_CREDENTIAL_REFERENCES,
		};
		try {
			await createProjectInDb(config);
			return config;
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				});
			}
			throw error;
		}
	}),

	update: publicProcedure
		.input(ProjectWriteInputSchema.partial().extend({ id: z.string() }))
		.mutation(async ({ input }) => {
			const existing = await getProjectByIdFromDb(input.id);
			if (!existing) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			const { id, ...updates } = input;
			const config = {
				...existing,
				...updates,
			};
			try {
				await upsertProjectToDb(config);
				return config;
			} catch (error) {
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'Project ID or repository already exists',
					});
				}
				throw error;
			}
		}),

	delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
		const existing = await getProjectByIdFromDb(input.id);
		if (!existing) {
			throw new TRPCError({
				code: 'NOT_FOUND',
				message: `Project with ID "${input.id}" not found`,
			});
		}
		await deleteProjectFromDb(input.id);
	}),
});
