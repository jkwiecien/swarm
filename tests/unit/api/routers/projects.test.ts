import { DrizzleQueryError } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	listAllProjectsFromDb: vi.fn(),
	getProjectByIdFromDb: vi.fn(),
	createProjectInDb: vi.fn(),
	upsertProjectToDb: vi.fn(),
	deleteProjectFromDb: vi.fn(),
}));

import { DEFAULT_GITHUB_PROJECTS_CONFIG, projectsRouter } from '@/api/routers/projects.js';
import {
	createProjectInDb,
	deleteProjectFromDb,
	getProjectByIdFromDb,
	listAllProjectsFromDb,
	upsertProjectToDb,
} from '@/db/repositories/projectsRepository.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

describe('projectsRouter', () => {
	const caller = projectsRouter.createCaller({});

	beforeEach(() => {
		vi.mocked(listAllProjectsFromDb).mockReset();
		vi.mocked(getProjectByIdFromDb).mockReset();
		vi.mocked(createProjectInDb).mockReset();
		vi.mocked(upsertProjectToDb).mockReset();
		vi.mocked(deleteProjectFromDb).mockReset();
	});

	describe('list', () => {
		it('returns whatever listAllProjectsFromDb resolves', async () => {
			const mockProjects = [
				createMockProjectConfig({ id: 'p1' }),
				createMockProjectConfig({ id: 'p2' }),
			];
			vi.mocked(listAllProjectsFromDb).mockResolvedValue(mockProjects);

			const result = await caller.list();
			expect(result).toEqual(mockProjects);
			expect(listAllProjectsFromDb).toHaveBeenCalledTimes(1);
		});

		it('returns an empty array when listAllProjectsFromDb resolves empty', async () => {
			vi.mocked(listAllProjectsFromDb).mockResolvedValue([]);

			const result = await caller.list();
			expect(result).toEqual([]);
			expect(listAllProjectsFromDb).toHaveBeenCalledTimes(1);
		});
	});

	describe('getById', () => {
		it('returns the project when getProjectByIdFromDb resolves one', async () => {
			const project = createMockProjectConfig({ id: 'p1', maxConcurrentJobs: 4 });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			const result = await caller.getById({ id: 'p1' });
			expect(result).toEqual(project);
			expect(result.maxConcurrentJobs).toBe(4);
			expect(getProjectByIdFromDb).toHaveBeenCalledWith('p1');
		});

		it('throws NOT_FOUND when getProjectByIdFromDb resolves undefined', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.getById({ id: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
		});
	});

	describe('create', () => {
		const validProjectInput = {
			id: 'new-proj',
			name: 'New Project',
			repo: 'jkwiecien/new-proj',
			repoRoot: '/Users/dev/new-proj',
			worktreeRoot: '.swarm-workspaces',
			baseBranch: 'main',
			branchPrefix: 'issue-',
			pm: { type: 'github-projects' as const },
		};

		const defaultCredentials = {
			implementer: 'SCM_TOKEN_IMPLEMENTER',
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SCM_WEBHOOK_SECRET',
		};

		it('happy path: calls createProjectInDb with the input plus credentials and returns the merged object', async () => {
			vi.mocked(createProjectInDb).mockResolvedValue(undefined);

			const result = await caller.create(validProjectInput);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectInDb).toHaveBeenCalledWith(expectedConfig);
		});

		it('create succeeds with only id/name/repo/repoRoot', async () => {
			vi.mocked(createProjectInDb).mockResolvedValue(undefined);

			const minimalInput = {
				id: 'minimal-proj',
				name: 'Minimal Project',
				repo: 'jkwiecien/minimal-proj',
				repoRoot: '/Users/dev/minimal-proj',
			};

			const result = await caller.create(minimalInput);

			const expectedConfig = {
				...minimalInput,
				worktreeRoot: '.swarm-workspaces',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				maxConcurrentJobs: 1,
				pm: { type: 'github-projects' as const },
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectInDb).toHaveBeenCalledWith(expectedConfig);
		});

		it('strips client-supplied credentials and uses defaults instead', async () => {
			vi.mocked(createProjectInDb).mockResolvedValue(undefined);

			// Cast as any to simulate malicious/careless client sending credentials key
			const inputWithCreds = {
				...validProjectInput,
				credentials: {
					implementer: 'MALICIOUS_IMPL',
					reviewer: 'MALICIOUS_REV',
					webhookSecret: 'MALICIOUS_SECRET',
				},
			} as unknown as Parameters<typeof caller.create>[0];

			const result = await caller.create(inputWithCreds);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectInDb).toHaveBeenCalledWith(expectedConfig);
		});

		it('strips client-supplied githubProjects and uses the placeholder default', async () => {
			vi.mocked(createProjectInDb).mockResolvedValue(undefined);

			// Cast as any to simulate client sending custom githubProjects
			const inputWithGithubProjects = {
				...validProjectInput,
				githubProjects: {
					projectId: 'CLIENT_ID',
					statusFieldId: 'CLIENT_FIELD_ID',
					statusOptions: { backlog: 'client-backlog' },
				},
			} as unknown as Parameters<typeof caller.create>[0];

			const result = await caller.create(inputWithGithubProjects);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectInDb).toHaveBeenCalledWith(expectedConfig);
		});

		it('translates duplicate constraint violation (code 23505) to CONFLICT', async () => {
			const error = Object.assign(new Error('Unique violation'), { code: '23505' });
			vi.mocked(createProjectInDb).mockRejectedValue(error);

			await expect(caller.create(validProjectInput)).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('translates a drizzle-wrapped unique violation (code on .cause, not top-level) to CONFLICT', async () => {
			// This is the shape drizzle-orm actually throws in production: every
			// node-postgres query error is wrapped in a `DrizzleQueryError`, which
			// has no top-level `code` — the real pg error (carrying `code: '23505'`)
			// is on `.cause`.
			const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
				code: '23505',
			});
			const wrapped = new DrizzleQueryError('insert into "projects" ...', [], pgError);
			vi.mocked(createProjectInDb).mockRejectedValue(wrapped);

			await expect(caller.create(validProjectInput)).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('propagates unrelated rejections without translating them', async () => {
			const error = new Error('Some DB connection error');
			vi.mocked(createProjectInDb).mockRejectedValue(error);

			await expect(caller.create(validProjectInput)).rejects.toThrowError(
				'Some DB connection error',
			);
		});
	});

	describe('update', () => {
		const existing = createMockProjectConfig({
			id: 'p1',
			name: 'Original Name',
			repo: 'jkwiecien/original',
		});

		it('throws NOT_FOUND when the project does not exist and does not update', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.update({ id: 'missing', name: 'New Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);

			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		it('happy path: updates project fields while leaving other fields untouched (including credentials)', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const updates = { id: 'p1', name: 'Updated Name', repo: 'jkwiecien/new-repo' };
			const result = await caller.update(updates);

			const expectedConfig = {
				...existing,
				name: 'Updated Name',
				repo: 'jkwiecien/new-repo',
			};

			expect(result).toEqual(expectedConfig);
			expect(upsertProjectToDb).toHaveBeenCalledWith(expectedConfig);
		});

		it('saves the maximum concurrent jobs setting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({ id: 'p1', maxConcurrentJobs: 4 });

			expect(result.maxConcurrentJobs).toBe(4);
			expect(upsertProjectToDb).toHaveBeenCalledWith({
				...existing,
				maxConcurrentJobs: 4,
			});
		});

		it('saves the opt-in auto merge setting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({
				id: 'p1',
				pipeline: { respondToReview: { autoMerge: true } },
			});

			expect(result.pipeline?.respondToReview?.autoMerge).toBe(true);
			expect(upsertProjectToDb).toHaveBeenCalledWith({
				...existing,
				pipeline: { respondToReview: { autoMerge: true } },
			});
		});

		it('saves the default-on skip-minors review-response setting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({
				id: 'p1',
				pipeline: { respondToReview: { skipOnMinors: false } },
			});

			expect(result.pipeline?.respondToReview?.skipOnMinors).toBe(false);
		});

		it('saves the Review check policy while leaving unrelated pipeline fields intact', async () => {
			const withPipeline = createMockProjectConfig({
				id: 'p1',
				name: 'Original Name',
				repo: 'jkwiecien/original',
				pipeline: {
					planning: { autoAdvance: true },
					review: { enabled: true },
					respondToReview: { autoMerge: true, skipOnMinors: false },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(withPipeline);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({
				id: 'p1',
				pipeline: {
					...withPipeline.pipeline,
					review: { ...withPipeline.pipeline?.review, checks: 'if-present' },
				},
			});

			expect(result.pipeline?.review?.checks).toBe('if-present');
			// Unrelated pipeline fields, including the rest of `review`, survive the update.
			expect(result.pipeline?.review?.enabled).toBe(true);
			expect(result.pipeline?.planning?.autoAdvance).toBe(true);
			expect(result.pipeline?.respondToReview).toEqual({ autoMerge: true, skipOnMinors: false });
		});

		it('does not invent a Review check policy for an unrelated update on a project with none stored', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({ id: 'p1', name: 'Renamed' });

			expect(result.pipeline?.review?.checks).toBeUndefined();
		});

		it.each([0, -1, 1.5, 'many'])('rejects invalid maximum concurrent jobs: %s', async (value) => {
			await expect(
				caller.update({ id: 'p1', maxConcurrentJobs: value as number }),
			).rejects.toThrow();
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		it('absent keys are not updated/merged to undefined', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			// Pass only id and a change to name, omit other fields
			const result = await caller.update({ id: 'p1', name: 'Name Change Only' });

			const expectedConfig = {
				...existing,
				name: 'Name Change Only',
			};

			expect(result).toEqual(expectedConfig);
			expect(upsertProjectToDb).toHaveBeenCalledWith(expectedConfig);
			// Verifies other attributes like repoRoot, baseBranch etc are still existing values
			expect(result.repo).toBe(existing.repo);
			expect(result.repoRoot).toBe(existing.repoRoot);
		});

		it('translates uniqueness conflicts (e.g. repo collision) to CONFLICT', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			const error = Object.assign(new Error('Unique violation'), { code: '23505' });
			vi.mocked(upsertProjectToDb).mockRejectedValue(error);

			await expect(caller.update({ id: 'p1', name: 'Collision Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('translates a drizzle-wrapped uniqueness conflict (code on .cause, not top-level) to CONFLICT', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
				code: '23505',
			});
			const wrapped = new DrizzleQueryError('insert into "projects" ...', [], pgError);
			vi.mocked(upsertProjectToDb).mockRejectedValue(wrapped);

			await expect(caller.update({ id: 'p1', name: 'Collision Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('propagates unrelated rejections without translating them', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			const error = new Error('Some DB connection error');
			vi.mocked(upsertProjectToDb).mockRejectedValue(error);

			await expect(caller.update({ id: 'p1', name: 'Error Name' })).rejects.toThrowError(
				'Some DB connection error',
			);
		});
	});

	describe('delete', () => {
		const existing = createMockProjectConfig({ id: 'p1' });

		it('throws NOT_FOUND when the project does not exist and does not delete', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.delete({ id: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);

			expect(deleteProjectFromDb).not.toHaveBeenCalled();
		});

		it('happy path: calls deleteProjectFromDb(id) when project existence check passes', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(deleteProjectFromDb).mockResolvedValue(undefined);

			await expect(caller.delete({ id: 'p1' })).resolves.toBeUndefined();
			expect(deleteProjectFromDb).toHaveBeenCalledWith('p1');
		});
	});
});
