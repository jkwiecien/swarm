import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ProjectConfigSchema } from '../../config/schema.js';
import { addMember } from '../../db/repositories/projectMembersRepository.js';
import {
	createProjectInDb,
	deleteProjectFromDb,
	getProjectByIdFromDb,
	listAllProjectsFromDb,
	upsertProjectToDb,
} from '../../db/repositories/projectsRepository.js';
import type { GitHubProjectsIntegrationConfig } from '../../integrations/pm/github-projects/config-schema.js';
import { assertProjectAccess, filterAccessibleProjects } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';
import { credentialsRouter } from './credentials.js';

export const DEFAULT_GITHUB_PROJECTS_CONFIG: GitHubProjectsIntegrationConfig = {
	projectId: '',
	statusFieldId: '',
	statusOptions: {},
};

const DEFAULT_CREDENTIAL_REFERENCES = {
	implementer: 'SCM_TOKEN_IMPLEMENTER',
	reviewer: 'SCM_TOKEN_REVIEWER',
	webhookSecret: 'SCM_WEBHOOK_SECRET',
};

const ProjectWriteInputSchema = ProjectConfigSchema.omit({ credentials: true });
const ProjectCreateInputSchema = ProjectWriteInputSchema.omit({ githubProjects: true });

function hasUniqueViolationCode(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === '23505'
	);
}

/**
 * drizzle-orm wraps every node-postgres query error in a `DrizzleQueryError`,
 * which has no top-level `code` — the original pg error (the one carrying
 * `code: '23505'` for a unique violation) is on `.cause`. Check both so this
 * still matches once drizzle's wrapping is in the way.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}

export const projectsRouter = router({
	// Only the caller's accessible projects: their membership set, or every
	// project for an `instanceAdmin` (`filterAccessibleProjects`, #281 task 4).
	list: authedProcedure.query(async ({ ctx }) => {
		return await filterAccessibleProjects(ctx.user, await listAllProjectsFromDb());
	}),

	getById: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			// A non-member gets NOT_FOUND here, so the read below never reveals that a
			// project they can't see exists.
			await assertProjectAccess(ctx.user, input.id, 'contributor');
			const project = await getProjectByIdFromDb(input.id);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			return project;
		}),

	// Any authenticated user may create a project and becomes its `projectAdmin`
	// (#281 task 4): the creator gets a membership row in the same call, so they
	// can immediately administer what they just created without an operator
	// seeding membership first. An `instanceAdmin` administers it regardless, but
	// the row is still written so the creator keeps access if their installation
	// role is later removed.
	create: authedProcedure.input(ProjectCreateInputSchema).mutation(async ({ ctx, input }) => {
		const config = {
			...input,
			githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
			credentials: DEFAULT_CREDENTIAL_REFERENCES,
		};
		try {
			await createProjectInDb(config);
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				});
			}
			throw error;
		}
		await addMember({ projectId: config.id, userId: ctx.user.id, role: 'projectAdmin' });
		return config;
	}),

	update: authedProcedure
		.input(ProjectWriteInputSchema.partial().extend({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Config changes are a `projectAdmin`-only action; a `member`/`contributor`
			// gets FORBIDDEN, a non-member NOT_FOUND.
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
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

	delete: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Deleting a project is `projectAdmin`-only (same boundary as `update`).
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
			const existing = await getProjectByIdFromDb(input.id);
			if (!existing) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			await deleteProjectFromDb(input.id);
		}),

	credentials: credentialsRouter,
});
