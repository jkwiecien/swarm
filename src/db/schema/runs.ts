import {
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core';
import type { DelegationObservation } from '../../delegation/native.js';
import type { AgentUsage } from '../../harness/usage.js';
import type { SwarmJob } from '../../queue/jobs.js';
import { projects } from './projects.js';

export const runs = pgTable(
	'runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		taskId: text('task_id').notNull(),
		workItemId: text('work_item_id'),
		workItemTitle: text('work_item_title'),
		workItemUrl: text('work_item_url'),
		prNumber: text('pr_number'),
		/**
		 * PR title for PR-driven phases (review / respond-to-*), fetched
		 * best-effort at run creation (`tryCreateRun`). Nullable: board-driven
		 * phases (planning/implementation) carry a `workItemTitle` instead, and
		 * pre-existing rows have none.
		 */
		prTitle: text('pr_title'),
		phase: text('phase').notNull(),
		engine: text('engine'),
		model: text('model'),
		/**
		 * The explicitly requested normalized reasoning level for this attempt
		 * (`src/harness/models.ts`, issue #180). Nullable: null means "Default" —
		 * no reasoning was configured, so the CLI/model used its own default.
		 */
		reasoning: text('reasoning'),
		status: text('status').notNull().default('running'),
		/**
		 * The formal verdict a completed Review run submitted (`gh pr review`'s
		 * `approve`/`request-changes`/`comment`, `src/pipeline/review.ts`), issue
		 * #218. Persisted so the runs list can show the review's actual outcome
		 * instead of a generic "Completed". Nullable: only Review runs that
		 * submitted a review set it — every other phase, and any pre-existing row,
		 * leaves it null. Cleared on a retry ({@link resetRunToRunning}) so a
		 * re-running review never shows a stale verdict.
		 */
		reviewVerdict: text('review_verdict'),
		exitCode: integer('exit_code'),
		timedOut: boolean('timed_out').notNull().default(false),
		error: text('error'),
		startedAt: timestamp('started_at').defaultNow().notNull(),
		completedAt: timestamp('completed_at'),
		nextRetryAt: timestamp('next_retry_at'),
		durationMs: integer('duration_ms'),
		/**
		 * Stored agent timeout (issue #165 review), capture the effective timeout
		 * in milliseconds for this attempt to accurately reconcile stale runs.
		 */
		timeoutMs: integer('timeout_ms'),
		/**
		 * Per-run token usage (issue #138), reported by the agent CLI where it
		 * exposes one — nullable: unsupported CLIs (`antigravity`/`codex`, until a
		 * follow-up task) and every pre-existing run have none.
		 */
		usage: jsonb('usage').$type<AgentUsage>(),
		/** Curated native child calls attributed to this parent phase run. */
		delegations: jsonb('delegations').$type<DelegationObservation[]>(),
		/**
		 * Persisted SwarmJob payload (issue #152) to allow retrying terminally
		 * failed runs. Nullable for backward compatibility.
		 */
		jobPayload: jsonb('job_payload').$type<SwarmJob>(),
		/** Claude Code session handle used to continue a deferred PM phase. */
		agentSessionId: uuid('agent_session_id'),
		outputBytes: integer('output_bytes').notNull().default(0),
		outputTruncated: boolean('output_truncated').notNull().default(false),
	},
	(table) => [
		index('idx_runs_project_id').on(table.projectId),
		index('idx_runs_status').on(table.status),
		index('idx_runs_started_at').on(table.startedAt),
	],
);

export const runLogs = pgTable('run_logs', {
	id: uuid('id').primaryKey().defaultRandom(),
	runId: uuid('run_id')
		.notNull()
		.unique()
		.references(() => runs.id, { onDelete: 'cascade' }),
	stdout: text('stdout'),
	stderr: text('stderr'),
});

export const runOutputEvents = pgTable(
	'run_output_events',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		runId: uuid('run_id')
			.notNull()
			.references(() => runs.id, { onDelete: 'cascade' }),
		stream: text('stream').$type<'stdout' | 'stderr'>().notNull(),
		content: text('content').notNull(),
		emittedAt: timestamp('emitted_at').defaultNow().notNull(),
	},
	(table) => [index('idx_run_output_events_cursor').on(table.runId, table.id)],
);
