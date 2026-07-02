/**
 * GitHub Projects status resolution — the provider-specific half of the
 * `pm:status-changed` trigger (ai/ARCHITECTURE.md "PM: GitHub Projects").
 *
 * The board speaks in opaque single-select *option IDs* (`47fc9ee4`), the
 * pipeline speaks in canonical status *keys* (`inProgress`). The config's
 * `statusOptions` map (`config-schema.ts`) is authored key → optionId; these
 * helpers invert that to answer "a card just landed on option X — which
 * pipeline phase, if any, does that start?". This is the piece the worker calls
 * after the authoritative item re-read (docs/github-projects-v2-api.md §5 step
 * 4): never branch on a status value lifted from the webhook body.
 *
 * IDs are matched by option ID, never by display name — names are rename-prone
 * and display-only (docs/github-projects-v2-api.md §2).
 */

import type { SingleSelectOptionId } from '../../../pm/ids.js';
import { unwrap } from '../../../pm/ids.js';
import type { PipelinePhase } from '../../../pm/pipeline.js';
import { resolvePipelinePhaseForStatusKey } from '../../../pm/pipeline.js';
import type { GitHubProjectsIntegrationConfig } from './config-schema.js';

/**
 * The canonical pipeline status key a board option ID maps to, or `undefined`
 * when the option isn't in the project's `statusOptions` map. Accepts a branded
 * `SingleSelectOptionId` (or a plain string) so callers can pass the value
 * straight from a re-read without unwrapping first.
 */
export function resolveStatusKeyByOptionId(
	config: GitHubProjectsIntegrationConfig,
	optionId: SingleSelectOptionId | string,
): string | undefined {
	const target = unwrap(optionId);
	for (const [statusKey, mappedOptionId] of Object.entries(config.statusOptions)) {
		if (mappedOptionId === target) return statusKey;
	}
	return undefined;
}

/**
 * The pipeline phase a board option ID starts, or `undefined` when the option
 * either isn't mapped in `statusOptions` or maps to a status that doesn't begin
 * a PM-driven phase (e.g. `backlog`, `inReview`, `done`) — a "not applicable"
 * lookup, not an error.
 */
export function resolvePipelinePhaseForOptionId(
	config: GitHubProjectsIntegrationConfig,
	optionId: SingleSelectOptionId | string,
): PipelinePhase | undefined {
	const statusKey = resolveStatusKeyByOptionId(config, optionId);
	return statusKey === undefined ? undefined : resolvePipelinePhaseForStatusKey(statusKey);
}
