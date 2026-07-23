import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import type { AgentCli } from '../../harness/agent-cli.js';
import { projects } from './projects.js';
import { workers } from './workers.js';

/**
 * One row per **worker-project enrollment** — the persisted form of
 * `WorkerEnrollment` (`src/identity/worker-enrollment.ts`), which stays the
 * source of truth for the shape (ai/CODING_STANDARDS.md "Zod is the source of
 * truth"). Phase 3 of the worker slice (ADR-001's third authorization layer):
 * where `workers` models a locally operated execution environment and
 * `worker_sessions` its one live claim, this links a worker to a project with a
 * project-scoped approval status, execution constraints, and the
 * owner-controlled sharing-consent flag the #130 dispatch gate reads.
 *
 * `worker_id` is a `workers.id` (`uuid`); `project_id` is a `projects.id`
 * (`text`). Both FKs are `ON DELETE CASCADE`, so an enrollment vanishes with
 * either its worker or its project and never dangles. The **unique index** on
 * `(worker_id, project_id)` is the enrollment identity: a worker holds at most
 * one enrollment per project; a re-enrollment is an update, not a second row.
 *
 * `status` is stored as free `text` (the Zod `EnrollmentStatusSchema` enum is
 * the source of truth for the values), matching how `project_members.role` /
 * `project_membership_requests.status` persist their enums. `allowed_clis` is a
 * `jsonb` of `AgentCli[]` (a subset of the worker's `capabilities`), the same
 * treatment `workers.capabilities` gets. `concurrency_allocation` is **nullable**
 * and defaults to `NULL` — an *optional* per-worker sub-limit: `NULL` means the
 * worker imposes no project-scoped cap of its own, so its concurrency for this
 * project is bounded only by its process-wide `SWARM_WORKER_CONCURRENCY`
 * (`src/worker/index.ts`, overridable per launch with `--concurrency`) and the
 * project's own `max_concurrent_jobs`. A positive integer narrows it further for
 * this one project. `sharing_consent` defaults to `false` (a fresh enrollment is
 * never routable until the owner opts in), so revoking consent is the owner's
 * explicit lever for flipping the routability predicate (`isRoutable`).
 *
 * The two secondary indexes serve the two read models: `project_id` for the
 * project roster (`listEnrollmentsForProject`) and `worker_id` for the owner
 * self-service view (`listEnrollmentsForWorker`).
 */
export const workerProjectEnrollments = pgTable(
	'worker_project_enrollments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		/** One of `EnrollmentStatusSchema` (`src/identity/worker-enrollment.ts`) — the source of truth for the values. */
		status: text('status').notNull().default('pending'),
		/** Subset of the worker's `capabilities` this project may run (source of truth in `worker-enrollment.ts`). */
		allowedClis: jsonb('allowed_clis').$type<AgentCli[]>().notNull(),
		/**
		 * Optional per-worker, per-project concurrency sub-limit. `NULL` (the
		 * default) = no cap of its own; a positive integer narrows this project's
		 * share of the worker. See the table doc-comment.
		 */
		concurrencyAllocation: integer('concurrency_allocation'),
		/** Owner-controlled, revocable; defaults false so a fresh enrollment is not routable until the owner opts in. */
		sharingConsent: boolean('sharing_consent').notNull().default(false),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		// At most one enrollment per (worker, project): the enrollment identity.
		uniqueIndex('idx_worker_enrollments_worker_project').on(table.workerId, table.projectId),
		// The project roster lookup (`listEnrollmentsForProject`).
		index('idx_worker_enrollments_project').on(table.projectId),
		// The owner self-service lookup — every enrollment for a worker (`listEnrollmentsForWorker`).
		index('idx_worker_enrollments_worker').on(table.workerId),
	],
);
