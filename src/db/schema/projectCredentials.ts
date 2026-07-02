import { pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

/**
 * Credentials at rest — mirrors Cascade's `project_credentials` table
 * (`cascade/src/db/schema/projectCredentials.ts`) verbatim in shape.
 *
 * Each row maps a project's env-var key (the *reference* stored in the project
 * config's `credentials` block) to its secret `value`. `value` is encrypted
 * with AES-256-GCM before it ever reaches this table, using the row's
 * `projectId` as AAD — see `src/db/crypto.ts`. The DB only ever sees ciphertext
 * when a `CREDENTIAL_MASTER_KEY` is configured.
 *
 * The unique index on `(projectId, envVarKey)` makes credential writes an
 * upsert target: one value per key per project.
 */
export const projectCredentials = pgTable(
	'project_credentials',
	{
		id: serial('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		envVarKey: text('env_var_key').notNull(),
		value: text('value').notNull(),
		name: text('name'),
		createdAt: timestamp('created_at').defaultNow(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex('uq_project_credentials_project_env_var_key').on(table.projectId, table.envVarKey),
	],
);
