import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveAllProjectCredentials: vi.fn(),
	writeProjectCredential: vi.fn(),
	deleteProjectCredential: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
}));

import { credentialsRouter } from '@/api/routers/credentials.js';
import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '@/db/repositories/credentialsRepository.js';
import { getProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

describe('credentialsRouter', () => {
	const caller = credentialsRouter.createCaller({});

	beforeEach(() => {
		vi.mocked(getProjectByIdFromDb).mockReset();
		vi.mocked(resolveAllProjectCredentials).mockReset();
		vi.mocked(writeProjectCredential).mockReset();
		vi.mocked(deleteProjectCredential).mockReset();
	});

	describe('list', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it('masks a long configured value to the same fixed marker, with no secret characters in the response', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				SCM_TOKEN_IMPLEMENTER: 'ghp_abcdefghijklmnop1234',
			});

			const result = await caller.list({ projectId: 'p1' });
			const raw = JSON.stringify(result);

			expect(raw).not.toContain('ghp_abcdefghijklmnop1234');
			expect(raw).not.toContain('1234');

			const entry = result.find((r) => r.role === 'implementer');
			expect(entry).toEqual({
				role: 'implementer',
				envVarKey: 'SCM_TOKEN_IMPLEMENTER',
				isConfigured: true,
				maskedValue: '****',
			});
		});

		it('masks a short configured value to the identical fixed marker as a long one', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				SCM_TOKEN_IMPLEMENTER: 'short',
			});

			const result = await caller.list({ projectId: 'p1' });
			const entry = result.find((r) => r.role === 'implementer');
			expect(entry?.maskedValue).toBe('****');
		});

		it('resolves a project still storing a legacy GitHub-named reference, unmigrated', async () => {
			const legacyProject = createMockProjectConfig({
				id: 'p1',
				credentials: {
					implementer: 'GITHUB_TOKEN_IMPLEMENTER',
					reviewer: 'GITHUB_TOKEN_REVIEWER',
					webhookSecret: 'GITHUB_WEBHOOK_SECRET',
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(legacyProject);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				GITHUB_TOKEN_IMPLEMENTER: 'ghp_abcdefghijklmnop1234',
			});

			const result = await caller.list({ projectId: 'p1' });
			const entry = result.find((r) => r.role === 'implementer');
			expect(entry).toEqual({
				role: 'implementer',
				envVarKey: 'GITHUB_TOKEN_IMPLEMENTER',
				isConfigured: true,
				maskedValue: '****',
			});
		});

		it('reports an unconfigured slot as isConfigured: false, maskedValue: "not set"', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.list({ projectId: 'p1' });
			const entry = result.find((r) => r.role === 'implementer');
			expect(entry).toEqual({
				role: 'implementer',
				envVarKey: 'SCM_TOKEN_IMPLEMENTER',
				isConfigured: false,
				maskedValue: 'not set',
			});
		});

		it('returns one entry per declared reference, in stable role order', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.list({ projectId: 'p1' });
			expect(result.map((r) => r.role)).toEqual(['implementer', 'reviewer', 'webhookSecret']);
		});

		it('throws NOT_FOUND for an unknown project without resolving credentials', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.list({ projectId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(resolveAllProjectCredentials).not.toHaveBeenCalled();
		});
	});

	describe('set', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it('calls writeProjectCredential with the given args', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await caller.set({ projectId: 'p1', envVarKey: 'SCM_TOKEN_IMPLEMENTER', value: 'secret' });

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_IMPLEMENTER',
				'secret',
				null,
			);
		});

		it('passes name through when provided', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await caller.set({
				projectId: 'p1',
				envVarKey: 'SCM_TOKEN_IMPLEMENTER',
				value: 'secret',
				name: 'Implementer token',
			});

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_IMPLEMENTER',
				'secret',
				'Implementer token',
			);
		});

		it('rejects an invalid envVarKey before touching the repository', async () => {
			await expect(
				caller.set({ projectId: 'p1', envVarKey: 'not-upper-snake', value: 'secret' }),
			).rejects.toThrow();
			expect(writeProjectCredential).not.toHaveBeenCalled();
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
		});

		it('rejects an empty value before touching the repository', async () => {
			await expect(
				caller.set({ projectId: 'p1', envVarKey: 'SCM_TOKEN_IMPLEMENTER', value: '' }),
			).rejects.toThrow();
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('throws NOT_FOUND for an unknown project without writing', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.set({
					projectId: 'missing',
					envVarKey: 'SCM_TOKEN_IMPLEMENTER',
					value: 'secret',
				}),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});
	});

	describe('delete', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it('calls deleteProjectCredential with the given args', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(deleteProjectCredential).mockResolvedValue(undefined);

			await caller.delete({ projectId: 'p1', envVarKey: 'SCM_TOKEN_IMPLEMENTER' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'SCM_TOKEN_IMPLEMENTER');
		});

		it('throws NOT_FOUND for an unknown project without deleting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.delete({ projectId: 'missing', envVarKey: 'SCM_TOKEN_IMPLEMENTER' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});
	});
});
