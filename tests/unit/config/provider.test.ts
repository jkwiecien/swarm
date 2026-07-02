import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
}));

import { findProjectByRepo, getPersonaToken, getPersonaTokenOrNull } from '@/config/provider.js';
import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
import { findProjectByRepoFromDb } from '@/db/repositories/projectsRepository.js';

const project = createMockProjectConfig({
	id: 'proj-1',
	credentials: {
		implementer: 'IMPL_TOKEN_KEY',
		reviewer: 'REV_TOKEN_KEY',
		webhookSecret: 'WEBHOOK_KEY',
	},
});

describe('config provider', () => {
	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
		vi.mocked(findProjectByRepoFromDb).mockReset();
	});

	describe('findProjectByRepo', () => {
		it('delegates to the repository', async () => {
			vi.mocked(findProjectByRepoFromDb).mockResolvedValue(project);
			expect(await findProjectByRepo('jkwiecien/swarm')).toBe(project);
			expect(findProjectByRepoFromDb).toHaveBeenCalledWith('jkwiecien/swarm');
		});
	});

	describe('getPersonaTokenOrNull', () => {
		it("resolves the persona's credential reference to its secret", async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('ghp_impl');
			const token = await getPersonaTokenOrNull(project, 'implementer');
			expect(token).toBe('ghp_impl');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'IMPL_TOKEN_KEY');
		});

		it('uses the reviewer reference for the reviewer persona', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('ghp_rev');
			await getPersonaTokenOrNull(project, 'reviewer');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'REV_TOKEN_KEY');
		});

		it('returns null when the reference resolves to nothing', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			expect(await getPersonaTokenOrNull(project, 'implementer')).toBeNull();
		});
	});

	describe('getPersonaToken', () => {
		it('returns the token when configured', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('ghp_impl');
			expect(await getPersonaToken(project, 'implementer')).toBe('ghp_impl');
		});

		it('throws when the persona token is not configured', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			await expect(getPersonaToken(project, 'reviewer')).rejects.toThrow(/reviewer token/);
		});
	});
});
