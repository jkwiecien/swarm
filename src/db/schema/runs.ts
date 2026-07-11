import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core';
import type { AgentUsage } from '../../harness/usage.js';
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
		phase: text('phase').notNull(),
		engine: text('engine'),
		model: text('model'),
		status: text('status').notNull().default('running'),
		exitCode: integer('exit_code'),
		timedOut: boolean('timed_out').notNull().default(false),
		error: text('error'),
		startedAt: timestamp('started_at').defaultNow().notNull(),
		completedAt: timestamp('completed_at'),
		nextRetryAt: timestamp('next_retry_at'),
		durationMs: integer('duration_ms'),
		/**
		 * Per-run token usage (issue #138), reported by the agent CLI where it
		 * exposes one — nullable: unsupported CLIs (`antigravity`/`codex`, until a
		 * follow-up task) and every pre-existing run have none.
		 */
		usage: jsonb('usage').$type<AgentUsage>(),
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
