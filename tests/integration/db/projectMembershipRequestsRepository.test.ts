import { beforeEach, describe, expect, it } from 'vitest';

import {
	approveMembershipRequestInDb,
	createMembershipRequest,
	getMembershipRequestById,
	getPendingRequest,
	listPendingRequestsForProject,
	rejectMembershipRequestInDb,
} from '../../../src/db/repositories/projectMembershipRequestsRepository.js';
import { addMember, getMembership } from '../../../src/db/repositories/projectMembersRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'projectMembershipRequestsRepository (integration)',
	() => {
		beforeEach(async () => {
			await truncateAll();
		});

		async function seedJoiner() {
			const user = await createUser({ identifier: 'joiner@example.com', displayName: 'Joiner' });
			await seedProject({
				id: 'proj-open',
				repo: 'jkwiecien/open-repo',
				visibility: 'discoverable',
			});
			return user;
		}

		it('files a pending request and resolves it by id / pending / list lookups', async () => {
			const user = await seedJoiner();
			const created = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });
			expect(created.status).toBe('pending');

			expect((await getMembershipRequestById(created.id))?.id).toBe(created.id);
			expect((await getPendingRequest(user.id, 'proj-open'))?.id).toBe(created.id);
			expect((await listPendingRequestsForProject('proj-open')).map((r) => r.id)).toEqual([
				created.id,
			]);
		});

		it('approval creates a contributor membership and marks the request approved, atomically', async () => {
			const user = await seedJoiner();
			const created = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });

			const result = await approveMembershipRequestInDb(created);
			expect(result).toBe(true);

			expect((await getMembership(user.id, 'proj-open'))?.role).toBe('contributor');
			expect((await getMembershipRequestById(created.id))?.status).toBe('approved');
			// No longer pending, so it drops off the admin-actionable list.
			expect(await getPendingRequest(user.id, 'proj-open')).toBeUndefined();
			expect(await listPendingRequestsForProject('proj-open')).toEqual([]);
		});

		it('approval never downgrades an existing higher role (idempotent membership insert)', async () => {
			const user = await seedJoiner();
			await addMember({ projectId: 'proj-open', userId: user.id, role: 'projectAdmin' });
			const created = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });

			const result = await approveMembershipRequestInDb(created);
			expect(result).toBe(true);

			expect((await getMembership(user.id, 'proj-open'))?.role).toBe('projectAdmin');
			expect((await getMembershipRequestById(created.id))?.status).toBe('approved');
		});

		it('rejection marks the request rejected and creates no membership', async () => {
			const user = await seedJoiner();
			const created = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });

			const result = await rejectMembershipRequestInDb(created.id);
			expect(result).toBe(true);

			expect((await getMembershipRequestById(created.id))?.status).toBe('rejected');
			expect(await getMembership(user.id, 'proj-open')).toBeUndefined();
		});

		it('prevents concurrent resolution: exactly one transition wins, status matches winner, and membership exists only if approval won', async () => {
			const user = await seedJoiner();
			const created = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });

			const [approveResult, rejectResult] = await Promise.all([
				approveMembershipRequestInDb(created),
				rejectMembershipRequestInDb(created.id),
			]);

			expect(approveResult !== rejectResult).toBe(true);
			if (approveResult) {
				expect((await getMembershipRequestById(created.id))?.status).toBe('approved');
				expect((await getMembership(user.id, 'proj-open'))?.role).toBe('contributor');
			} else {
				expect((await getMembershipRequestById(created.id))?.status).toBe('rejected');
				expect(await getMembership(user.id, 'proj-open')).toBeUndefined();
			}
		});

		it('returns false when attempting to resolve a request that is no longer pending', async () => {
			const user = await seedJoiner();
			const created = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });

			expect(await rejectMembershipRequestInDb(created.id)).toBe(true);
			expect(await approveMembershipRequestInDb(created)).toBe(false);
			expect(await rejectMembershipRequestInDb(created.id)).toBe(false);

			expect((await getMembershipRequestById(created.id))?.status).toBe('rejected');
			expect(await getMembership(user.id, 'proj-open')).toBeUndefined();
		});

		it('allows at most one pending request per (project, user), but a fresh one after resolution', async () => {
			const user = await seedJoiner();
			const first = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });

			// A second pending request violates the partial unique index.
			await expect(
				createMembershipRequest({ projectId: 'proj-open', userId: user.id }),
			).rejects.toThrow();

			// Once the first is resolved, a fresh request is allowed.
			await rejectMembershipRequestInDb(first.id);
			const second = await createMembershipRequest({ projectId: 'proj-open', userId: user.id });
			expect(second.status).toBe('pending');
			expect(second.id).not.toBe(first.id);
		});
	},
);
