import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client.js', () => ({ getDb: vi.fn() }));

import { getDb } from '@/db/client.js';
import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';

/**
 * Stub the drizzle fluent chain `select().from().where().limit()` so it resolves
 * to `rows`. The unit test's job is the decrypt-and-map logic around the query,
 * not the SQL itself (that's covered by the integration suite).
 */
function stubDb(rows: unknown[]): void {
	const builder = {
		select: () => builder,
		from: () => builder,
		where: () => builder,
		limit: () => Promise.resolve(rows),
	};
	vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);
}

describe('resolveProjectCredential', () => {
	beforeEach(() => {
		vi.mocked(getDb).mockReset();
		vi.unstubAllEnvs();
	});

	it('returns null when no credential row matches', async () => {
		stubDb([]);
		expect(await resolveProjectCredential('proj-1', 'MISSING_KEY')).toBeNull();
	});

	it('returns the plaintext value when encryption is disabled', async () => {
		stubDb([{ value: 'ghp_plaintext' }]);
		expect(await resolveProjectCredential('proj-1', 'IMPL_TOKEN_KEY')).toBe('ghp_plaintext');
	});

	it('decrypts a stored value using the projectId as AAD', async () => {
		const { randomBytes } = await import('node:crypto');
		vi.stubEnv('CREDENTIAL_MASTER_KEY', randomBytes(32).toString('hex'));
		const { encryptCredential } = await import('@/db/crypto.js');
		const ciphertext = encryptCredential('ghp_secret', 'proj-1');

		stubDb([{ value: ciphertext }]);
		expect(await resolveProjectCredential('proj-1', 'IMPL_TOKEN_KEY')).toBe('ghp_secret');
	});
});
