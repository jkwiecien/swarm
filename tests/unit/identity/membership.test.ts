import { describe, expect, it } from 'vitest';

import {
	canAdministerProject,
	canReadProject,
	canWriteProject,
	PROJECT_ROLES,
	ProjectMembershipSchema,
	ProjectRoleSchema,
	projectRoleRank,
	roleAtLeast,
} from '@/identity/membership.js';

const validMembership = {
	id: '11111111-1111-4111-8111-111111111111',
	projectId: 'proj-alpha',
	userId: '22222222-2222-4222-8222-222222222222',
	role: 'member' as const,
	createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('ProjectRoleSchema', () => {
	it('accepts the three known roles', () => {
		expect(PROJECT_ROLES).toEqual(['projectAdmin', 'member', 'contributor']);
		for (const role of PROJECT_ROLES) {
			expect(ProjectRoleSchema.parse(role)).toBe(role);
		}
	});

	it('rejects an unknown role', () => {
		expect(() => ProjectRoleSchema.parse('owner')).toThrow();
	});
});

describe('ProjectMembershipSchema', () => {
	it('accepts a valid membership', () => {
		expect(ProjectMembershipSchema.parse(validMembership)).toEqual(validMembership);
	});

	it('rejects a non-uuid id and userId', () => {
		expect(() => ProjectMembershipSchema.parse({ ...validMembership, id: 'nope' })).toThrow();
		expect(() => ProjectMembershipSchema.parse({ ...validMembership, userId: 'nope' })).toThrow();
	});

	it('rejects an empty projectId', () => {
		expect(() => ProjectMembershipSchema.parse({ ...validMembership, projectId: '' })).toThrow();
	});

	it('rejects an unknown role', () => {
		expect(() => ProjectMembershipSchema.parse({ ...validMembership, role: 'owner' })).toThrow();
	});
});

describe('role ordering', () => {
	it('ranks projectAdmin > member > contributor', () => {
		expect(projectRoleRank('projectAdmin')).toBeGreaterThan(projectRoleRank('member'));
		expect(projectRoleRank('member')).toBeGreaterThan(projectRoleRank('contributor'));
	});

	it('roleAtLeast compares by rank in both directions', () => {
		expect(roleAtLeast('projectAdmin', 'contributor')).toBe(true);
		expect(roleAtLeast('member', 'member')).toBe(true);
		expect(roleAtLeast('contributor', 'member')).toBe(false);
	});
});

describe('access predicates', () => {
	it('canAdministerProject is projectAdmin only', () => {
		expect(canAdministerProject('projectAdmin')).toBe(true);
		expect(canAdministerProject('member')).toBe(false);
		expect(canAdministerProject('contributor')).toBe(false);
	});

	it('canWriteProject is member and up', () => {
		expect(canWriteProject('projectAdmin')).toBe(true);
		expect(canWriteProject('member')).toBe(true);
		expect(canWriteProject('contributor')).toBe(false);
	});

	it('canReadProject is every role', () => {
		expect(canReadProject('projectAdmin')).toBe(true);
		expect(canReadProject('member')).toBe(true);
		expect(canReadProject('contributor')).toBe(true);
	});
});
