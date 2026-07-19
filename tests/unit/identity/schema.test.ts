import { describe, expect, it } from 'vitest';

import { installationRoleFor, isInstanceAdmin, SwarmUserSchema } from '@/identity/schema.js';

const validUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada Lovelace',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('SwarmUserSchema', () => {
	it('accepts a valid user', () => {
		expect(SwarmUserSchema.parse(validUser)).toEqual(validUser);
	});

	it('rejects an empty identifier', () => {
		expect(() => SwarmUserSchema.parse({ ...validUser, identifier: '' })).toThrow();
	});

	it('rejects an empty displayName', () => {
		expect(() => SwarmUserSchema.parse({ ...validUser, displayName: '' })).toThrow();
	});

	it('rejects a non-uuid id', () => {
		expect(() => SwarmUserSchema.parse({ ...validUser, id: 'not-a-uuid' })).toThrow();
	});
});

describe('isInstanceAdmin', () => {
	it('is true only when the flag is set', () => {
		expect(isInstanceAdmin({ instanceAdmin: true })).toBe(true);
		expect(isInstanceAdmin({ instanceAdmin: false })).toBe(false);
	});
});

describe('installationRoleFor', () => {
	it('maps the flag to the named role', () => {
		expect(installationRoleFor({ instanceAdmin: true })).toBe('instanceAdmin');
		expect(installationRoleFor({ instanceAdmin: false })).toBe('user');
	});
});
