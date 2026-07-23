import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/usersRepository.js', () => ({
	findUserCredentialByIdentifier: vi.fn(),
	getUserById: vi.fn(),
	ensureLocalAdminUser: vi.fn(),
}));

vi.mock('@/db/repositories/userSessionsRepository.js', () => ({
	insertSession: vi.fn(),
	findUserIdBySessionToken: vi.fn(),
	deleteSessionByToken: vi.fn(),
	deleteExpiredSessions: vi.fn(),
}));

import {
	deleteExpiredSessions,
	deleteSessionByToken,
	findUserIdBySessionToken,
	insertSession,
} from '@/db/repositories/userSessionsRepository.js';
import {
	ensureLocalAdminUser,
	findUserCredentialByIdentifier,
	getUserById,
} from '@/db/repositories/usersRepository.js';
import {
	createSession,
	hashPassword,
	resolveSession,
	resolveSingleUser,
	revokeSession,
	verifyCredentials,
	verifyPassword,
} from '@/identity/auth.js';
import type { SwarmUser } from '@/identity/schema.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const user: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date('2020-01-01T00:00:00Z'),
	updatedAt: new Date('2020-01-01T00:00:00Z'),
};

beforeEach(() => {
	vi.mocked(findUserCredentialByIdentifier).mockReset();
	vi.mocked(getUserById).mockReset();
	vi.mocked(insertSession).mockReset().mockResolvedValue(undefined);
	vi.mocked(findUserIdBySessionToken).mockReset();
	vi.mocked(deleteSessionByToken).mockReset().mockResolvedValue(undefined);
	vi.mocked(deleteExpiredSessions).mockReset().mockResolvedValue(0);
	vi.mocked(ensureLocalAdminUser).mockReset();
});

describe('password hashing', () => {
	it('round-trips a correct password and rejects a wrong one', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
		expect(await verifyPassword('wrong password', hash)).toBe(false);
	});

	it('uses a fresh salt so the same password hashes differently each time', async () => {
		const a = await hashPassword('same');
		const b = await hashPassword('same');
		expect(a).not.toBe(b);
		// Both still verify — the salt lives in the stored value.
		expect(await verifyPassword('same', a)).toBe(true);
		expect(await verifyPassword('same', b)).toBe(true);
	});

	it('never stores the plaintext in the hash', async () => {
		const hash = await hashPassword('supersecret');
		expect(hash).not.toContain('supersecret');
		expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
	});

	it('returns false (never throws) for a malformed stored hash', async () => {
		expect(await verifyPassword('x', '')).toBe(false);
		expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
		expect(await verifyPassword('x', ':')).toBe(false);
	});
});

describe('verifyCredentials', () => {
	it('returns the user for a correct identifier + password', async () => {
		const passwordHash = await hashPassword('hunter2');
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue({ user, passwordHash });

		expect(await verifyCredentials('ada@example.com', 'hunter2')).toEqual(user);
	});

	it('returns undefined for a wrong password', async () => {
		const passwordHash = await hashPassword('hunter2');
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue({ user, passwordHash });

		expect(await verifyCredentials('ada@example.com', 'nope')).toBeUndefined();
	});

	it('returns undefined for an unknown user', async () => {
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue(undefined);
		expect(await verifyCredentials('ghost@example.com', 'whatever')).toBeUndefined();
	});

	it('returns undefined for a user with no password set', async () => {
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue({ user, passwordHash: null });
		expect(await verifyCredentials('ada@example.com', 'whatever')).toBeUndefined();
	});
});

describe('session lifecycle', () => {
	it('mints a session storing only the token hash, never the raw token', async () => {
		const { token, expiresAt } = await createSession(user.id);

		expect(token).toBeTruthy();
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(insertSession).toHaveBeenCalledTimes(1);
		const stored = vi.mocked(insertSession).mock.calls[0][0];
		expect(stored.userId).toBe(user.id);
		expect(stored.tokenHash).toBe(sha256(token));
		expect(stored.tokenHash).not.toBe(token);
	});

	it('resolves a live session token to its user (looked up by hash)', async () => {
		vi.mocked(findUserIdBySessionToken).mockResolvedValue(user.id);
		vi.mocked(getUserById).mockResolvedValue(user);

		expect(await resolveSession('raw-token')).toEqual(user);
		expect(findUserIdBySessionToken).toHaveBeenCalledWith(sha256('raw-token'));
	});

	it('returns undefined for an unknown/expired token and for an empty token', async () => {
		vi.mocked(findUserIdBySessionToken).mockResolvedValue(undefined);
		expect(await resolveSession('stale')).toBeUndefined();
		expect(await resolveSession('')).toBeUndefined();
		expect(findUserIdBySessionToken).toHaveBeenCalledTimes(1); // not called for the empty token
	});

	it('revokes a session by its hashed token', async () => {
		await revokeSession('raw-token');
		expect(deleteSessionByToken).toHaveBeenCalledWith(sha256('raw-token'));
	});
});

describe('resolveSingleUser', () => {
	it('returns the ensured local admin without touching any session state', async () => {
		const admin: SwarmUser = { ...user, displayName: 'Local Admin', instanceAdmin: true };
		vi.mocked(ensureLocalAdminUser).mockResolvedValue(admin);

		expect(await resolveSingleUser()).toEqual(admin);
		expect(ensureLocalAdminUser).toHaveBeenCalledTimes(1);
		// The single-user path is deliberately session-free.
		expect(findUserIdBySessionToken).not.toHaveBeenCalled();
		expect(insertSession).not.toHaveBeenCalled();
	});
});
