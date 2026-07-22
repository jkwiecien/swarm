/**
 * Provider-neutral automation opt-in label (issue #131).
 *
 * A work item must carry the project's configured automation label before SWARM
 * starts an agent phase for it — the explicit, human-controlled "yes, automate
 * this" marker. The helpers live here (beside `src/pm/dependencies.ts`) rather
 * than at the call site because the label is a *work-item* concept, not a GitHub
 * one: it is resolved through {@link WorkItem.labels}, which every PM adapter
 * populates from its own native labels (GitHub Issue labels today; a Trello /
 * Jira / Linear adapter maps its card labels onto the same field). No
 * `PMProvider` method is needed — the existing field already is the capability
 * (ai/RULES.md §2 "widen the interface" only applies when it's too small).
 *
 * The label is an automation opt-in, **never an access-control mechanism**: it
 * cannot grant a user or a worker access to a project, and removing it only
 * stops future dispatches (ADR-001's authorization layers are separate and
 * unaffected by anything here).
 */

import type { PipelineConfig } from '../config/schema.js';
import type { WorkItem } from './types.js';

/**
 * The opt-in label used when a project configures none. Matches the convention
 * `ai/RULES.md` §5 already requires of every SWARM issue.
 */
export const DEFAULT_AUTOMATION_LABEL = 'swarm';

/**
 * The label this project requires on a work item, or `undefined` when the gate
 * is switched off (`pipeline.automationLabel: ""` — an explicitly empty string
 * is an authoritative "no gate", the same convention `agents.targets` uses for
 * an empty list).
 *
 * The default is applied here rather than with `z.default()` because `pipeline`
 * itself is optional: a project with no `pipeline` block would never see a Zod
 * default, and it must still be gated.
 */
export function resolveAutomationLabel(pipeline: PipelineConfig | undefined): string | undefined {
	const configured = pipeline?.automationLabel;
	if (configured === undefined) return DEFAULT_AUTOMATION_LABEL;
	return configured === '' ? undefined : configured;
}

/**
 * Whether `workItem` carries `label` — an exact, case-sensitive name match.
 * Deliberately not case-folded or fuzzy: the configured value is copied verbatim
 * by the operator, and a gate that guesses is worse than one that is
 * predictable.
 */
export function hasAutomationLabel(workItem: WorkItem, label: string): boolean {
	return workItem.labels.some((l) => l.name === label);
}

/** The reason logged (and recorded on a retried run) when the gate skips a dispatch. */
export function missingAutomationLabelMessage(label: string): string {
	return `Skipped: the work item does not carry the '${label}' automation label, so SWARM will not start a phase for it. Add the label to opt this item into automation.`;
}
