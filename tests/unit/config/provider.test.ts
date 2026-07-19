import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
	findProjectByBoardFromDb: vi.fn(),
}));

import {
	findProjectByBoard,
	findProjectByRepo,
	getPersonaToken,
	getPersonaTokenOrNull,
	getWebhookSecretOrNull,
} from '@/config/provider.js';
import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
import {
	findProjectByBoardFromDb,
	findProjectByRepoFromDb,
} from '@/db/repositories/projectsRepository.js';

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
		vi.mocked(findProjectByBoardFromDb).mockReset();
	});

	describe('findProjectByRepo', () => {
		it('delegates to the repository', async () => {
			vi.mocked(findProjectByRepoFromDb).mockResolvedValue(project);
			expect(await findProjectByRepo('jkwiecien/swarm')).toBe(project);
			expect(findProjectByRepoFromDb).toHaveBeenCalledWith('jkwiecien/swarm');
		});
	});

	describe('findProjectByBoard', () => {
		it('delegates to the repository with the board node ID', async () => {
			vi.mocked(findProjectByBoardFromDb).mockResolvedValue(project);
			expect(await findProjectByBoard('PVT_kwHOAC3TF84BcNwD')).toBe(project);
			expect(findProjectByBoardFromDb).toHaveBeenCalledWith('PVT_kwHOAC3TF84BcNwD');
		});
	});

	describe('getPersonaTokenOrNull', () => {
		it("resolves the persona's credential reference to its secret", async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('test-token-implementer');
			const token = await getPersonaTokenOrNull(project, 'implementer');
			expect(token).toBe('test-token-implementer');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'IMPL_TOKEN_KEY');
		});

		it('uses the reviewer reference for the reviewer persona', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('test-token-reviewer');
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
			vi.mocked(resolveProjectCredential).mockResolvedValue('test-token-implementer');
			expect(await getPersonaToken(project, 'implementer')).toBe('test-token-implementer');
		});

		it('throws when the persona token is not configured', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			await expect(getPersonaToken(project, 'reviewer')).rejects.toThrow(/reviewer token/);
		});
	});

	describe('getWebhookSecretOrNull', () => {
		it("resolves the project's webhook-secret reference to its secret", async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('whsec_123');
			expect(await getWebhookSecretOrNull(project)).toBe('whsec_123');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'WEBHOOK_KEY');
		});

		it('returns null when the reference resolves to nothing', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			expect(await getWebhookSecretOrNull(project)).toBeNull();
		});
	});
});
