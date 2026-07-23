import type { GitHubProjectsIntegrationConfig } from '../../../src/integrations/pm/github-projects/config-schema.js';
import { PM_STATUS_KEYS, type PmStatusKey } from '../../../src/pm/pipeline.js';

/**
 * The GitHub Projects board-mapping form's editable state — the two board node
 * IDs plus one option-ID entry per canonical pipeline status key. Kept flat and
 * string-only (blank = unset) so it maps directly onto controlled inputs; it is
 * projected to/from the provider's {@link GitHubProjectsIntegrationConfig} shape
 * by the helpers below rather than the component reaching into config internals.
 */
export interface BoardMappingForm {
	projectId: string;
	statusFieldId: string;
	statusOptions: Record<PmStatusKey, string>;
}

/**
 * The six canonical pipeline status keys (`PM_STATUS_KEYS` — the single source
 * of truth in `src/pm/pipeline.ts`) paired with the display labels the board
 * uses for them (ai/RULES.md §5). `todo` surfaces as "Ready" to match the live
 * board's option name; the key itself stays canonical.
 */
export const STATUS_KEY_LABELS: Readonly<Record<PmStatusKey, string>> = {
	backlog: 'Backlog',
	planning: 'Planning',
	todo: 'Ready',
	inProgress: 'In progress',
	inReview: 'In review',
	done: 'Done',
};

/** Ordered status keys for stable field rendering (pipeline order, not object order). */
export const STATUS_KEYS = PM_STATUS_KEYS;

/** An empty option-ID map with every canonical key present, for seeding blank state. */
function emptyStatusOptions(): Record<PmStatusKey, string> {
	return Object.fromEntries(STATUS_KEYS.map((key) => [key, ''])) as Record<PmStatusKey, string>;
}

/**
 * Project the stored `githubProjects` config onto the flat form state, filling a
 * blank string for any status key the board hasn't mapped yet so every field is
 * a controlled input. `statusOptions` is an open record on the config (a board
 * may carry non-canonical keys); only the canonical keys are surfaced here.
 */
export function toBoardMappingForm(
	config: GitHubProjectsIntegrationConfig | undefined,
): BoardMappingForm {
	const statusOptions = emptyStatusOptions();
	for (const key of STATUS_KEYS) {
		const value = config?.statusOptions?.[key];
		if (value) statusOptions[key] = value;
	}
	return {
		projectId: config?.projectId ?? '',
		statusFieldId: config?.statusFieldId ?? '',
		statusOptions,
	};
}

/** Drop blank option entries so a cleared field isn't persisted as an empty string. */
export function cleanStatusOptions(
	statusOptions: Record<PmStatusKey, string>,
): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const key of STATUS_KEYS) {
		const value = statusOptions[key]?.trim();
		if (value) clean[key] = value;
	}
	return clean;
}

/**
 * Build the `githubProjects` payload for `projects.update` from the form state,
 * preserving any `phaseLabels` already on the stored config — the mapping screen
 * doesn't edit those (issue #84 scope), so they must survive a save unchanged.
 */
export function buildGithubProjectsUpdate(
	form: BoardMappingForm,
	existing: GitHubProjectsIntegrationConfig | undefined,
): GitHubProjectsIntegrationConfig {
	return {
		projectId: form.projectId.trim(),
		statusFieldId: form.statusFieldId.trim(),
		statusOptions: cleanStatusOptions(form.statusOptions),
		...(existing?.phaseLabels ? { phaseLabels: existing.phaseLabels } : {}),
	};
}

/** Whether the form differs from the stored config (compared after normalization). */
export function isBoardMappingDirty(
	form: BoardMappingForm,
	config: GitHubProjectsIntegrationConfig | undefined,
): boolean {
	const stored = toBoardMappingForm(config);
	if (form.projectId.trim() !== stored.projectId) return true;
	if (form.statusFieldId.trim() !== stored.statusFieldId) return true;
	return STATUS_KEYS.some(
		(key) => (form.statusOptions[key]?.trim() ?? '') !== stored.statusOptions[key],
	);
}
