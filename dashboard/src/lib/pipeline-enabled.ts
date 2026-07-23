import type { PipelineConfig, ReviewChecksPolicy } from '../../../src/config/schema.js';

/**
 * The three optional, SCM-event-driven pipeline phases a project can turn off
 * (`pipeline.<phase>.enabled`, added in #118). Planning and Implementation are
 * mandatory and carry no toggle; Resolve-conflicts has no `enabled` flag either.
 */
export const PIPELINE_TOGGLE_PHASES = ['review', 'respondToReview', 'respondToCi'] as const;

export type PipelineTogglePhase = (typeof PIPELINE_TOGGLE_PHASES)[number];

/**
 * The Agent Configuration screen's enable/disable state — one boolean per
 * optional phase (`true` = the phase runs). Projected to/from the stored
 * {@link PipelineConfig} by the helpers below so the component never reads the
 * config's tri-state (`enabled: true | false | undefined`) directly.
 */
export type PipelineEnabledForm = Record<PipelineTogglePhase, boolean>;

/** The mandatory phase whose completion move is configurable. */
export const AUTO_ADVANCE_PHASES = ['planning'] as const;

export type PipelineAutoAdvancePhase = (typeof AUTO_ADVANCE_PHASES)[number];

export type PipelineAutoAdvanceForm = Record<PipelineAutoAdvancePhase, boolean>;

/**
 * Project Planning's auto-advance override onto the dashboard form, retaining
 * the coded default when no override is stored.
 */
export function toPipelineAutoAdvanceForm(
	pipeline: PipelineConfig | undefined,
): PipelineAutoAdvanceForm {
	return {
		planning: pipeline?.planning?.autoAdvance ?? false,
	};
}

/**
 * Project the stored pipeline config onto the flat form state. An unset `enabled`
 * defaults to `true` (the phase runs unless explicitly disabled — matching the
 * trigger handlers, which only skip on `enabled === false`).
 */
export function toPipelineEnabledForm(pipeline: PipelineConfig | undefined): PipelineEnabledForm {
	return {
		review: pipeline?.review?.enabled !== false,
		respondToReview: pipeline?.respondToReview?.enabled !== false,
		respondToCi: pipeline?.respondToCi?.enabled !== false,
	};
}

/**
 * Toggle one phase's flag, enforcing the dependency that Respond-to-review cannot
 * be on while Review is off (mirrors #118's server-side refinement and the
 * dependent-Select pattern in DESIGN_SYSTEM §4): turning Review off forces
 * Respond-to-review off in the same update, so the form can't hold a state that
 * would fail validation on save.
 */
export function setPhaseEnabled(
	form: PipelineEnabledForm,
	phase: PipelineTogglePhase,
	enabled: boolean,
): PipelineEnabledForm {
	const next = { ...form, [phase]: enabled };
	if (phase === 'review' && !enabled) next.respondToReview = false;
	return next;
}

/**
 * Whether the Respond-to-review toggle is locked off — true whenever Review is
 * disabled, since the phase depends on a review verdict existing.
 */
export function isRespondToReviewLocked(form: PipelineEnabledForm): boolean {
	return !form.review;
}

/**
 * Build the `pipeline` payload for `projects.update` from the form, preserving
 * every existing pipeline field the Agent Configuration screen doesn't edit
 * (Planning's autoAdvance/autoSplit, Respond-to-review's
 * autoMerge/skipOnMinors). `projects.update` shallow-merges, so an omitted field
 * here would be dropped — hence the spreads. Respond-to-review is forced off when
 * Review is off to satisfy the server-side refinement.
 */
export function buildPipelineEnabledUpdate(
	form: PipelineEnabledForm,
	existing: PipelineConfig | undefined,
): PipelineConfig {
	return {
		...existing,
		review: { ...existing?.review, enabled: form.review },
		respondToReview: {
			...existing?.respondToReview,
			enabled: form.review ? form.respondToReview : false,
		},
		respondToCi: { ...existing?.respondToCi, enabled: form.respondToCi },
	};
}

/**
 * Merge the dashboard's Planning auto-advance value into a complete pipeline
 * payload. The other fields must survive because
 * `projects.update` replaces the top-level pipeline object rather than merging
 * its nested values.
 */
export function buildPipelineAutoAdvanceUpdate(
	form: PipelineAutoAdvanceForm,
	existing: PipelineConfig | undefined,
): PipelineConfig {
	return {
		...existing,
		planning: { ...existing?.planning, autoAdvance: form.planning },
	};
}

/** Whether the form differs from the stored pipeline config. */
export function isPipelineEnabledDirty(
	form: PipelineEnabledForm,
	pipeline: PipelineConfig | undefined,
): boolean {
	const stored = toPipelineEnabledForm(pipeline);
	return PIPELINE_TOGGLE_PHASES.some((phase) => form[phase] !== stored[phase]);
}

/** Whether Planning's auto-advance selection differs from its effective stored value. */
export function isPipelineAutoAdvanceDirty(
	form: PipelineAutoAdvanceForm,
	pipeline: PipelineConfig | undefined,
): boolean {
	const stored = toPipelineAutoAdvanceForm(pipeline);
	return AUTO_ADVANCE_PHASES.some((phase) => form[phase] !== stored[phase]);
}

/** Toggle one phase's auto-advance flag. */
export function setAutoAdvanceEnabled(
	form: PipelineAutoAdvanceForm,
	phase: PipelineAutoAdvancePhase,
	enabled: boolean,
): PipelineAutoAdvanceForm {
	return { ...form, [phase]: enabled };
}

/** Whether the given phase supports auto-advance. */
export function isAutoAdvancePhase(phase: string): phase is PipelineAutoAdvancePhase {
	return (AUTO_ADVANCE_PHASES as readonly string[]).includes(phase);
}

/**
 * Return the stored auto-advance setting that controls a displayed phase.
 */
export function autoAdvanceConfigPhase(phase: string): PipelineAutoAdvancePhase | undefined {
	return isAutoAdvancePhase(phase) ? phase : undefined;
}

/** The safe default Review check policy — matches the Review trigger's own fallback. */
export const DEFAULT_REVIEW_CHECKS_POLICY: ReviewChecksPolicy = 'required';

/**
 * Resolve the effective Review check policy for the dashboard's radio group,
 * falling back to the safe `required` default when the project has no stored
 * value (new project, or one that predates #283).
 */
export function toReviewChecksPolicyForm(pipeline: PipelineConfig | undefined): ReviewChecksPolicy {
	return pipeline?.review?.checks ?? DEFAULT_REVIEW_CHECKS_POLICY;
}

/** Whether the selected Review check policy differs from the effective stored value. */
export function isReviewChecksPolicyDirty(
	policy: ReviewChecksPolicy,
	pipeline: PipelineConfig | undefined,
): boolean {
	return policy !== toReviewChecksPolicyForm(pipeline);
}

/**
 * Build the `pipeline` payload for `projects.update`, changing only
 * `review.checks` while preserving every other stored pipeline field —
 * `projects.update` replaces the whole `pipeline` object rather than merging
 * it, so an omitted field here would be dropped.
 */
export function buildReviewChecksPolicyUpdate(
	policy: ReviewChecksPolicy,
	existing: PipelineConfig | undefined,
): PipelineConfig {
	return {
		...existing,
		review: { ...existing?.review, checks: policy },
	};
}

/** Summary string describing the auto-advance behavior for the phase and its setting. */
export function autoAdvanceSummary(phase: string, enabled: boolean | undefined): string {
	if (enabled === undefined) return 'N/A';
	return phase === 'planning'
		? enabled
			? 'On — moves to ToDo after posting the plan'
			: 'Off — stays in Planning'
		: 'N/A';
}
