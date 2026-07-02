import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	getPersonaTokenOrNull: vi.fn(),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({
	getGitHubUserForToken: vi.fn(),
}));

import { getPersonaTokenOrNull } from '@/config/provider.js';
import { getGitHubUserForToken } from '@/integrations/scm/github/client.js';
import {
	_resetPersonaIdentityCache,
	getPersonaForAgentType,
	getPersonaForLogin,
	isSwarmBot,
	type PersonaIdentities,
	resolvePersonaIdentities,
} from '@/integrations/scm/github/personas.js';

const IDENTITIES: PersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };

describe('personas', () => {
	beforeEach(() => {
		_resetPersonaIdentityCache();
	});

	describe('getPersonaForAgentType', () => {
		it('maps the review agent to the reviewer persona', () => {
			expect(getPersonaForAgentType('review')).toBe('reviewer');
		});

		it('maps implementation-side agents to the implementer persona', () => {
			expect(getPersonaForAgentType('implementation')).toBe('implementer');
			expect(getPersonaForAgentType('respond-to-review')).toBe('implementer');
		});

		it('defaults unknown agent types to the implementer persona', () => {
			expect(getPersonaForAgentType('some-future-agent')).toBe('implementer');
		});
	});

	describe('isSwarmBot', () => {
		it('recognizes both persona logins', () => {
			expect(isSwarmBot('swarm-impl', IDENTITIES)).toBe(true);
			expect(isSwarmBot('swarm-rev', IDENTITIES)).toBe(true);
		});

		it('recognizes the [bot]-suffixed App forms', () => {
			expect(isSwarmBot('swarm-impl[bot]', IDENTITIES)).toBe(true);
			expect(isSwarmBot('swarm-rev[bot]', IDENTITIES)).toBe(true);
		});

		it('does not flag a human login', () => {
			expect(isSwarmBot('some-human', IDENTITIES)).toBe(false);
		});
	});

	describe('getPersonaForLogin', () => {
		it('resolves each persona, including the [bot] form', () => {
			expect(getPersonaForLogin('swarm-impl', IDENTITIES)).toBe('implementer');
			expect(getPersonaForLogin('swarm-rev[bot]', IDENTITIES)).toBe('reviewer');
		});

		it('returns null for a non-persona login', () => {
			expect(getPersonaForLogin('some-human', IDENTITIES)).toBeNull();
		});
	});

	describe('resolvePersonaIdentities', () => {
		const project = createMockProjectConfig();

		it('resolves both persona logins from their tokens', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'tok-impl' : 'tok-rev',
			);
			vi.mocked(getGitHubUserForToken).mockImplementation(async (tok) =>
				tok === 'tok-impl' ? 'swarm-impl' : 'swarm-rev',
			);

			const identities = await resolvePersonaIdentities(project);
			expect(identities).toEqual(IDENTITIES);
		});

		it('caches per-project — a second call does not re-resolve', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue('tok');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-impl');

			await resolvePersonaIdentities(project);
			const callsAfterFirst = vi.mocked(getGitHubUserForToken).mock.calls.length;
			await resolvePersonaIdentities(project);
			expect(vi.mocked(getGitHubUserForToken).mock.calls.length).toBe(callsAfterFirst);
		});

		it('throws when the implementer identity cannot be resolved', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue(null);
			vi.mocked(getGitHubUserForToken).mockResolvedValue(null);

			await expect(resolvePersonaIdentities(project)).rejects.toThrow(/implementer/);
		});

		it('throws when only the reviewer identity is missing', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'tok-impl' : null,
			);
			vi.mocked(getGitHubUserForToken).mockImplementation(async (tok) =>
				tok === 'tok-impl' ? 'swarm-impl' : null,
			);

			await expect(resolvePersonaIdentities(project)).rejects.toThrow(/reviewer/);
		});
	});
});
