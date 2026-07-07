import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	listAllProjectsFromDb: vi.fn(),
	getProjectByIdFromDb: vi.fn(),
	createProjectInDb: vi.fn(),
	upsertProjectToDb: vi.fn(),
	deleteProjectFromDb: vi.fn(),
}));

import { projectsRouter } from '@/api/routers/projects.js';
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
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			const result = await caller.getById({ id: 'p1' });
			expect(result).toEqual(project);
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
			githubProjects: {
				projectId: 'PVT_1',
				statusFieldId: 'PVTSSF_1',
				statusOptions: {
					backlog: 'b1',
					planning: 'p1',
					todo: 't1',
					inProgress: 'ip1',
					inReview: 'ir1',
					done: 'd1',
				},
			},
		};

		const defaultCredentials = {
			implementer: 'GITHUB_TOKEN_IMPLEMENTER',
			reviewer: 'GITHUB_TOKEN_REVIEWER',
			webhookSecret: 'GITHUB_WEBHOOK_SECRET',
		};

		it('happy path: calls createProjectInDb with the input plus credentials and returns the merged object', async () => {
			vi.mocked(createProjectInDb).mockResolvedValue(undefined);

			const result = await caller.create(validProjectInput);

			const expectedConfig = {
				...validProjectInput,
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
