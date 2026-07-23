import { z } from 'zod';

/** The tabs on the General Settings screen, in display order (issue #250 added `appearance`). */
export const SETTINGS_TABS = ['agents', 'appearance'] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * Search-param schema for `/settings`. The active tab lives in the URL — not
 * component state — so switching tabs is a real browser-history entry and a
 * direct/reload link lands on the right panel (mirrors `project-nav.ts`'s
 * `projectDetailSearchSchema`). `.catch(undefined)` degrades a stale or
 * hand-edited unknown tab to the default rather than throwing.
 */
export const settingsSearchSchema = z.object({
	tab: z.enum(SETTINGS_TABS).optional().catch(undefined),
});

export type SettingsSearch = z.infer<typeof settingsSearchSchema>;

/** The tab to render for a given search state — Agent Defaults is the default. */
export function resolveActiveSettingsTab(search: SettingsSearch): SettingsTab {
	return search.tab ?? 'agents';
}

/** Search state for switching to a tab. */
export function settingsTabSearch(tab: SettingsTab): SettingsSearch {
	return { tab };
}
