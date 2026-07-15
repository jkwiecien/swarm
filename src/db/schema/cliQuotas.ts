import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { CliQuotaSnapshot } from '../../harness/quota.js';

/**
 * Persisted host-local capability and quota snapshot per agent CLI (issue #164).
 *
 * Stored in the DB so that the worker (which is running on the host and has CLI
 * access) can populate/refresh it, and the dashboard API/UI can consume it
 * without probing the host.
 */
export const cliQuotas = pgTable('cli_quotas', {
	/** The agent CLI identifier: 'claude', 'antigravity', or 'codex' */
	cli: text('cli').primaryKey(),
	/** The overall availability status: 'available', 'unavailable', or 'error' */
	status: text('status').notNull(),
	/** The detailed provider-neutral quota snapshot JSON blob */
	snapshot: jsonb('snapshot').$type<CliQuotaSnapshot>().notNull(),
	createdAt: timestamp('created_at').defaultNow(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date()),
});
