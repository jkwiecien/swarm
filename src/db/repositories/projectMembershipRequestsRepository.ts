/**
 * Membership-request persistence — plain functions, one `getDb()` per call, no
 * class, mirroring `projectMembersRepository.ts`. Backs the
 * `project_membership_requests` table (`src/db/schema/projectMembershipRequests.ts`),
 * the persisted form of `MembershipRequest` (`src/identity/membership-request.ts`,
 * the source of truth for the shape). The open-project join flow of the
 * multi-user foundation (ADR-001, issue #281 task 5).
 *
 * A row already carries the domain's exact types, so mapping it back to
 * `MembershipRequest` is a re-assembly, not a re-validation — same as
 * `rowToMembership` (`status` is persisted as free `text`, cast back to the
 * enum the writers here only ever store). Creating a second *pending* request
 * for the same `(project, user)` surfaces the raw pg `23505` unique violation
 * on the partial index; the router translates it to a friendly `CONFLICT`.
 */

import { and, asc, eq } from 'drizzle-orm';

import type {
	MembershipRequest,
	MembershipRequestStatus,
} from '../../identity/membership-request.js';
import { getDb } from '../client.js';
import { projectMembers } from '../schema/projectMembers.js';
import { projectMembershipRequests } from '../schema/projectMembershipRequests.js';

type RequestRow = typeof projectMembershipRequests.$inferSelect;

/** Re-assemble a `MembershipRequest` from a persisted row. */
function rowToRequest(row: RequestRow): MembershipRequest {
	return {
		id: row.id,
		projectId: row.projectId,
		userId: row.userId,
		status: row.status as MembershipRequestStatus,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The fields a caller supplies to file a request; `id`/`status`/timestamps are generated. */
export interface CreateMembershipRequestInput {
	projectId: string;
	userId: string;
}

/**
 * File a `pending` membership request. Rejects with the pg `23505` unique
 * violation if this user already has a pending request for this project (the
 * partial unique index) — a resolved request does not block a fresh one.
 */
export async function createMembershipRequest(
	input: CreateMembershipRequestInput,
): Promise<MembershipRequest> {
	const [row] = await getDb()
		.insert(projectMembershipRequests)
		.values({ projectId: input.projectId, userId: input.userId })
		.returning();
	return rowToRequest(row);
}

/** Resolve a user's *pending* request for one project, or `undefined` if there is none. */
export async function getPendingRequest(
	userId: string,
	projectId: string,
): Promise<MembershipRequest | undefined> {
	const rows = await getDb()
		.select()
		.from(projectMembershipRequests)
		.where(
			and(
				eq(projectMembershipRequests.userId, userId),
				eq(projectMembershipRequests.projectId, projectId),
				eq(projectMembershipRequests.status, 'pending'),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToRequest(row) : undefined;
}

/** Resolve a request by its id. Returns `undefined` if unknown. */
export async function getMembershipRequestById(id: string): Promise<MembershipRequest | undefined> {
	const rows = await getDb()
		.select()
		.from(projectMembershipRequests)
		.where(eq(projectMembershipRequests.id, id))
		.limit(1);
	const row = rows[0];
	return row ? rowToRequest(row) : undefined;
}

/** List a project's *pending* requests, oldest first (the admin-actionable set). */
export async function listPendingRequestsForProject(
	projectId: string,
): Promise<MembershipRequest[]> {
	const rows = await getDb()
		.select()
		.from(projectMembershipRequests)
		.where(
			and(
				eq(projectMembershipRequests.projectId, projectId),
				eq(projectMembershipRequests.status, 'pending'),
			),
		)
		.orderBy(asc(projectMembershipRequests.createdAt), asc(projectMembershipRequests.id));
	return rows.map(rowToRequest);
}

/**
 * Approve a request: add the requester as a `contributor` and mark the request
 * `approved`, atomically in one transaction. The membership insert is
 * idempotent (`onConflictDoNothing` on the `(project, user)` uniqueness), so
 * approving a request for someone who became a member in the meantime simply
 * resolves the request without disturbing their existing (possibly higher)
 * role. Approval only ever grants `contributor` (read) — never a role that
 * could drive runs or administer the project.
 */
export async function approveMembershipRequestInDb(request: MembershipRequest): Promise<void> {
	await getDb().transaction(async (tx) => {
		await tx
			.insert(projectMembers)
			.values({ projectId: request.projectId, userId: request.userId, role: 'contributor' })
			.onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.userId] });
		await tx
			.update(projectMembershipRequests)
			.set({ status: 'approved' })
			.where(eq(projectMembershipRequests.id, request.id));
	});
}

/** Mark a request `rejected`. Grants no membership. */
export async function rejectMembershipRequestInDb(id: string): Promise<void> {
	await getDb()
		.update(projectMembershipRequests)
		.set({ status: 'rejected' })
		.where(eq(projectMembershipRequests.id, id));
}
