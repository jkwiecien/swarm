/**
 * Project **membership requests** — the open-project join flow (ADR-001, issue
 * #281 task 5). Where `ProjectMembership` (`./membership.ts`) models an
 * *established* member, a membership request models someone *asking* to join a
 * `discoverable` project: it is created by `projects.requestMembership` and
 * resolved (approved → a `contributor` membership, or rejected) by a
 * `projectAdmin`/`instanceAdmin`.
 *
 * This resolves ADR-001 open question #1 in favour of a **request/approve**
 * flow rather than immediate membership: joining an open project never grants
 * access on its own, keeping discovery and joining separate from execution. The
 * Zod schema here is the source of truth for the shape (ai/CODING_STANDARDS.md
 * "Zod is the source of truth"); the `project_membership_requests` table
 * (`src/db/schema/projectMembershipRequests.ts`) is its persisted form.
 */

import { z } from 'zod';

/**
 * The lifecycle state of a membership request. A request starts `pending`; a
 * `projectAdmin`/`instanceAdmin` moves it to exactly one terminal state —
 * `approved` (a `contributor` membership is created) or `rejected`. A resolved
 * request is never re-opened; the requester files a fresh one instead.
 */
export const MembershipRequestStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type MembershipRequestStatus = z.infer<typeof MembershipRequestStatusSchema>;

/**
 * A single membership request: one SWARM user asking to join one project.
 * `projectId` is a `projects.id` (`text`), `userId` a `users.id` (`uuid`); `id`
 * is the request row's own generated `uuid`. At most one `pending` request per
 * `(projectId, userId)` (enforced by a partial unique index on the table).
 */
export const MembershipRequestSchema = z.object({
	id: z.string().uuid(),
	projectId: z.string().min(1),
	userId: z.string().uuid(),
	status: MembershipRequestStatusSchema,
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type MembershipRequest = z.infer<typeof MembershipRequestSchema>;
