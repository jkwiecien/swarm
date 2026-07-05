import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client.js', () => ({ getDb: vi.fn() }));

import { getDb } from '@/db/client.js';
import {
	resolveAllProjectCredentials,
	resolveProjectCredential,
	writeProjectCredential,
} from '@/db/repositories/credentialsRepository.js';

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

/**
 * Stub a sequence of select queries: each `await` of the fluent chain consumes
 * the next entry in `resultQueue`, so a function issuing two selects (e.g. the
 * project-existence check followed by the rows query) gets each its own result.
 */
function stubDbQueue(resultQueue: unknown[][]): void {
	let call = 0;
	const builder = {
		select: () => builder,
		from: () => builder,
		where: () => builder,
		limit: () => builder,
		// biome-ignore lint/suspicious/noThenProperty: the stub must be awaitable like a drizzle query builder
		then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
			Promise.resolve(resultQueue[call++]).then(resolve, reject),
	};
	vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);
}

describe('resolveAllProjectCredentials', () => {
	beforeEach(() => {
		vi.mocked(getDb).mockReset();
		vi.unstubAllEnvs();
	});

	it('throws when the project does not exist', async () => {
		stubDbQueue([[]]);
		await expect(resolveAllProjectCredentials('nope')).rejects.toThrow('Project not found: nope');
	});

	it('decrypts each row into an env-var-key → value map', async () => {
		const { randomBytes } = await import('node:crypto');
		vi.stubEnv('CREDENTIAL_MASTER_KEY', randomBytes(32).toString('hex'));
		const { encryptCredential } = await import('@/db/crypto.js');

		stubDbQueue([
			[{ id: 'proj-1' }],
			[
				{ envVarKey: 'IMPL', value: encryptCredential('ghp_impl', 'proj-1') },
				{ envVarKey: 'LEGACY', value: 'plaintext' },
			],
		]);
		expect(await resolveAllProjectCredentials('proj-1')).toEqual({
			IMPL: 'ghp_impl',
			LEGACY: 'plaintext',
		});
	});
});

describe('writeProjectCredential', () => {
	beforeEach(() => {
		vi.mocked(getDb).mockReset();
		vi.unstubAllEnvs();
	});

	it('encrypts with the projectId as AAD before the upsert', async () => {
		const { randomBytes } = await import('node:crypto');
		vi.stubEnv('CREDENTIAL_MASTER_KEY', randomBytes(32).toString('hex'));
		const { decryptCredential, isEncryptedValue } = await import('@/db/crypto.js');

		let inserted: { value: string } | undefined;
		let conflictSet: { value: string } | undefined;
		const builder = {
			insert: () => builder,
			values: (v: { value: string }) => {
				inserted = v;
				return builder;
			},
			onConflictDoUpdate: (opts: { set: { value: string } }) => {
				conflictSet = opts.set;
				return Promise.resolve();
			},
		};
		vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);

		await writeProjectCredential('proj-1', 'IMPL', 'ghp_secret');

		expect(inserted && isEncryptedValue(inserted.value)).toBe(true);
		expect(inserted && decryptCredential(inserted.value, 'proj-1')).toBe('ghp_secret');
		// The conflict branch must update to the same ciphertext, not re-encrypt.
		expect(conflictSet?.value).toBe(inserted?.value);
	});
});
