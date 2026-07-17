import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { AppSettings } from '../../config/app-settings.js';

/**
 * SWARM's global (app-wide) settings — the persisted form of `AppSettings`
 * (`src/config/app-settings.ts`), which stays the source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). The `settings` jsonb
 * column is typed with the config's own inferred type via `$type<>()` so the
 * table and the Zod schema can't drift (same pattern as `projects.ts`).
 *
 * Single-row by design: SWARM is single-user scoped (ai/ARCHITECTURE.md
 * "Single-user scope"), so there's exactly one global-settings record, pinned
 * to the `'global'` sentinel id. The repository upserts against that id, so
 * writes are idempotent and reads never have to disambiguate rows. Storing the
 * settings as one blob (rather than a column per setting) lets future global
 * settings be added without a migration.
 */
export const appSettings = pgTable('app_settings', {
	/** Single-row sentinel — there is exactly one global-settings record. */
	id: text('id').primaryKey().default('global'),
	/**
	 * The whole settings object (`AppSettings`) as one jsonb blob. The SQL-level
	 * default stays the pre-#250 literal `{}` (not `APP_SETTINGS_DEFAULTS`, which
	 * now includes `appearance`) so this column definition doesn't drift from
	 * the migration already applied — every read re-validates through
	 * `AppSettingsSchema` anyway (`appSettingsRepository.ts`), which fills in
	 * `appearance` regardless of what's actually stored.
	 */
	settings: jsonb('settings')
		.$type<AppSettings>()
		.notNull()
		.default({} as AppSettings),
	createdAt: timestamp('created_at').defaultNow(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date()),
});
