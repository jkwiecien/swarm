import { describe, expect, it } from 'vitest';
import { normalizeIdentityKey, UserIdentitySchema } from '@/identity/user-identity.js';

const VALID = {
	id: '11111111-1111-4111-8111-111111111111',
	userId: '22222222-2222-4222-8222-222222222222',
	provider: 'github-projects',
	handle: 'ada',
	createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('UserIdentitySchema', () => {
	it('accepts a well-formed link', () => {
		expect(UserIdentitySchema.parse(VALID)).toEqual(VALID);
	});

	it('rejects a non-uuid id/userId and an empty provider/handle', () => {
		expect(UserIdentitySchema.safeParse({ ...VALID, id: 'nope' }).success).toBe(false);
		expect(UserIdentitySchema.safeParse({ ...VALID, userId: 'nope' }).success).toBe(false);
		expect(UserIdentitySchema.safeParse({ ...VALID, provider: '' }).success).toBe(false);
		expect(UserIdentitySchema.safeParse({ ...VALID, handle: '' }).success).toBe(false);
	});
});

describe('normalizeIdentityKey', () => {
	it('trims and lowercases, so casing/whitespace never splits a link', () => {
		// An operator linking ' Ada ' must still match the 'ada' a provider reports.
		expect(normalizeIdentityKey(' Ada ')).toBe('ada');
		expect(normalizeIdentityKey('GitHub-Projects')).toBe('github-projects');
	});

	it('leaves an already-normalized key untouched', () => {
		expect(normalizeIdentityKey('ada')).toBe('ada');
	});
});
