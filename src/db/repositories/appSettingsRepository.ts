/**
 * Global (app-wide) settings persistence — mirrors the plain-function shape of
 * `projectsRepository.ts` (one `getDb()` per call, no class), trimmed to SWARM's
 * single-user scope (ai/ARCHITECTURE.md "Single-user scope"). The settings live
 * in the single-row `app_settings` table pinned to the `'global'` sentinel id
 * (`src/db/schema/appSettings.ts`).
 *
 * The `settings` jsonb column is already typed with the config's inferred type
 * (`AppSettings`, `src/config/app-settings.ts`), so reading a row back is a
 * re-assembly, not a re-validation — the Zod schema stays the source of truth
 * for the shape (ai/CODING_STANDARDS.md "Zod is the source of truth"). Writes go
 * through the `settings` tRPC router, which validates the input against
 * `AppSettingsSchema` before it ever reaches here.
 */

import { eq } from 'drizzle-orm';

import { APP_SETTINGS_DEFAULTS, type AppSettings } from '../../config/app-settings.js';
import { getDb } from '../client.js';
import { appSettings } from '../schema/appSettings.js';

/** The single-row sentinel id — there is exactly one global-settings record. */
const GLOBAL_ID = 'global';

/**
 * Resolve the global settings — the singleton `global` row merged over the coded
 * defaults. Returns {@link APP_SETTINGS_DEFAULTS} when the row is absent (nothing
 * has been configured yet), so callers always get a valid `AppSettings` without
 * a null check; the coded per-CLI defaults still apply downstream.
 */
export async function getAppSettings(): Promise<AppSettings> {
	const rows = await getDb()
		.select()
		.from(appSettings)
		.where(eq(appSettings.id, GLOBAL_ID))
		.limit(1);
	const row = rows[0];
	return row ? row.settings : APP_SETTINGS_DEFAULTS;
}

/**
 * Persist the global settings — an idempotent upsert on the `global` id
 * (`insert … onConflictDoUpdate`), so the first write inserts the singleton row
 * and every later write replaces it in place rather than inserting a duplicate.
 * Returns the stored settings.
 */
export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
	await getDb()
		.insert(appSettings)
		.values({ id: GLOBAL_ID, settings })
		.onConflictDoUpdate({
			target: appSettings.id,
			set: { settings, updatedAt: new Date() },
		});
	return settings;
}
