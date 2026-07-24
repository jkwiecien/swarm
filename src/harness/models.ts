/**
 * Per-model capability metadata — the single source of truth for what
 * `AgentConfig.model` / `AgentConfig.reasoning` (`src/config/schema.ts`) accept,
 * and what the dashboard's per-phase Agent Configuration offers as choices
 * (the phase-6 dashboard backlog).
 *
 * Each logical model is described by a {@link ModelCapability}: a stable
 * configured id (what config stores), a user-facing label, the normalized
 * reasoning levels it supports, and — for `antigravity` — the exact `agy models`
 * variant string each reasoning level maps to. Reasoning is normalized to one
 * enum ({@link REASONING_LEVELS}, surfaced as "Reasoning" in the UI) but its
 * launch mapping stays per-CLI (`resolveModelLaunch`) — we never pretend the
 * CLIs share argument semantics or that a level means the same compute across
 * providers (issue #180).
 *
 * The three CLIs expose reasoning differently:
 *  - `claude`: a separate `--effort <low|medium|high|xhigh|max>` flag; the model
 *    is a short alias (`sonnet`, `opus`, …) that always resolves to the current
 *    model in that tier.
 *  - `codex`: a separate `model_reasoning_effort` config value passed as
 *    `-c model_reasoning_effort="<level>"`; models are short identifiers.
 *  - `antigravity` (agy 1.1.5+): the reasoning effort is part of the model
 *    *slug* `agy models` prints (`gemini-3.6-flash-high`) — the string `--model`
 *    pins reliably — so a logical model + reasoning maps back to that exact slug.
 *    agy also grew a separate `--effort low|medium|high` flag, but SWARM keeps
 *    driving it through the combined slug rather than the flag. Single-variant
 *    models (`claude-sonnet-4-6`, `gpt-oss-120b-medium`) expose no reasoning
 *    choice — their slug is fixed. Pre-1.1.5 agy printed parenthesized display
 *    strings (`"Gemini 3.5 Flash (High)"`) instead; those linger only as legacy
 *    config values (`LEGACY_ANTIGRAVITY_DISPLAY_STRINGS`), never a launch target.
 *
 * These are capability *inputs* observed on the current dev host, not a promise
 * that provider catalogs never change — hence the legacy back-compat sets
 * (§below) and `resolveModelLaunch`'s fail-visibly behavior.
 */

import { z } from 'zod';
import type { AgentCli } from './agent-cli.js';

/**
 * Normalized reasoning levels shown in the UI, ordered lightest → heaviest.
 * Claude's `--effort` enum verbatim; a superset the other CLIs draw a subset
 * from per-model. Not a claim that a level costs the same compute across CLIs.
 */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Zod enum for a normalized reasoning level — the boundary validator (issue #180). */
export const ReasoningLevelSchema = z.enum(REASONING_LEVELS);

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
	return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * One logical model a phase/run can be configured to use.
 *
 * `id` is the stable value stored in config (`AgentConfig.model`) — a claude
 * alias, a codex short id, or a *logical* antigravity name (`gemini-3.5-flash`,
 * not the combined `"Gemini 3.5 Flash (High)"` display string). `label` is what
 * the dashboard's Model selector shows.
 *
 * `reasoningChoices` are the normalized levels the user may pick; an empty list
 * means the model exposes no reasoning choice (an antigravity single-variant
 * model, or any model whose CLI we don't drive with a level). `defaultReasoning`
 * is the level used when none is chosen and it is discoverable — `null` when the
 * CLI controls the default itself (claude) or none is reliably known.
 *
 * `variantByReasoning` / `fixedVariant` are antigravity-only: they carry the
 * exact `agy models` string each reasoning level maps to (`variantByReasoning`)
 * or the single fixed variant (`fixedVariant`). Absent for claude/codex, whose
 * `id` is passed to `--model` directly.
 */
export interface ModelCapability {
	cli: AgentCli;
	id: string;
	label: string;
	reasoningChoices: readonly ReasoningLevel[];
	defaultReasoning: ReasoningLevel | null;
	/** antigravity: normalized level → exact `agy models` variant string. */
	variantByReasoning?: Partial<Record<ReasoningLevel, string>>;
	/** antigravity single-variant models: the one exact `agy models` string. */
	fixedVariant?: string;
}

const CLAUDE_EFFORTS = REASONING_LEVELS;

/**
 * Per-model reasoning support is a **hand-maintained catalog**, not something the
 * CLIs expose a clean machine-readable list for. Update the `choices`/`default`
 * below when a provider's model lineup or its reasoning knobs change. A model
 * with an empty `choices` list exposes **no reasoning control** — the config
 * schema rejects a reasoning level for it and the dashboard shows the selector
 * disabled ("Fixed"), the same as an antigravity single-variant model.
 *
 * Sources (verified 2026-07, links in PR): Claude effort matrix
 * (platform.claude.com/docs/build-with-claude/effort — effort supported by
 * Fable 5 / Opus 4.8 / Sonnet 5, default `high`; **Haiku 4.5 does NOT support
 * the effort parameter** — it only does budget-based thinking, which SWARM's
 * `--effort` harness can't drive, so it is non-reasoning here); Codex effort
 * levels (OpenAI GPT-5.6 Sol/Terra/Luna expose none→max; GPT-5.5/5.4 up to
 * xhigh; GPT-5.4 mini caps at high).
 */

/** `claude --model <alias> --effort <level>`. Effort defaults to `high` where supported. */
const CLAUDE_CAPABILITIES: readonly ModelCapability[] = [
	{ id: 'fable', label: 'Fable', choices: CLAUDE_EFFORTS, default: 'high' as const },
	{ id: 'opus', label: 'Opus', choices: CLAUDE_EFFORTS, default: 'high' as const },
	{ id: 'sonnet', label: 'Sonnet', choices: CLAUDE_EFFORTS, default: 'high' as const },
	// Haiku 4.5 has no `--effort` control (budget-based thinking only) → no reasoning.
	{ id: 'haiku', label: 'Haiku', choices: [], default: null },
].map(({ id, label, choices, default: def }) => ({
	cli: 'claude' as const,
	id,
	label,
	reasoningChoices: choices as readonly ReasoningLevel[],
	defaultReasoning: def,
}));

/**
 * `codex --model <id> -c model_reasoning_effort="<level>"`. Codex defaults to
 * `medium`; supported sets are model-specific (the GPT-5.6 family exposes the
 * widest range up to `max`, GPT-5.5/5.4 up to `xhigh`, mini caps at `high`).
 */
const CODEX_CAPABILITIES: readonly ModelCapability[] = [
	{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', choices: REASONING_LEVELS },
	{ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', choices: REASONING_LEVELS },
	{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', choices: REASONING_LEVELS },
	{ id: 'gpt-5.5', label: 'GPT-5.5', choices: ['low', 'medium', 'high', 'xhigh'] },
	{ id: 'gpt-5.4', label: 'GPT-5.4', choices: ['low', 'medium', 'high', 'xhigh'] },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', choices: ['low', 'medium', 'high'] },
].map(({ id, label, choices }) => ({
	cli: 'codex' as const,
	id,
	label,
	reasoningChoices: choices as readonly ReasoningLevel[],
	defaultReasoning: 'medium' as const,
}));

/**
 * `agy --model <slug>`. The logical model + reasoning re-combine into the exact
 * `agy models` slug (`gemini-3.6-flash-high`). Flash/Pro expose reasoning tiers;
 * the Claude/GPT-OSS entries are single fixed slugs (no reasoning choice).
 */
const ANTIGRAVITY_CAPABILITIES: readonly ModelCapability[] = [
	{
		cli: 'antigravity',
		id: 'gemini-3.5-flash',
		label: 'Gemini 3.5 Flash',
		reasoningChoices: ['low', 'medium', 'high'],
		defaultReasoning: 'medium',
		variantByReasoning: {
			low: 'gemini-3.5-flash-low',
			medium: 'gemini-3.5-flash-medium',
			high: 'gemini-3.5-flash-high',
		},
	},
	{
		cli: 'antigravity',
		id: 'gemini-3.6-flash',
		label: 'Gemini 3.6 Flash',
		reasoningChoices: ['low', 'medium', 'high'],
		defaultReasoning: 'medium',
		variantByReasoning: {
			low: 'gemini-3.6-flash-low',
			medium: 'gemini-3.6-flash-medium',
			high: 'gemini-3.6-flash-high',
		},
	},
	{
		cli: 'antigravity',
		id: 'gemini-3.1-pro',
		label: 'Gemini 3.1 Pro',
		reasoningChoices: ['low', 'high'],
		// Pro exposes no medium tier; default to high (the heavier tier) so an
		// un-reasoned Pro selection still launches a real, documented variant.
		defaultReasoning: 'high',
		variantByReasoning: {
			low: 'gemini-3.1-pro-low',
			high: 'gemini-3.1-pro-high',
		},
	},
	{
		cli: 'antigravity',
		id: 'claude-sonnet-4.6',
		label: 'Claude Sonnet 4.6',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'claude-sonnet-4-6',
	},
	{
		cli: 'antigravity',
		id: 'claude-opus-4.6',
		label: 'Claude Opus 4.6',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'claude-opus-4-6-thinking',
	},
	{
		cli: 'antigravity',
		id: 'gpt-oss-120b',
		label: 'GPT-OSS 120B',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'gpt-oss-120b-medium',
	},
];

/** Every logical model, keyed by CLI. The catalog the whole app reads. */
export const MODEL_CAPABILITIES: Readonly<Record<AgentCli, readonly ModelCapability[]>> = {
	claude: CLAUDE_CAPABILITIES,
	antigravity: ANTIGRAVITY_CAPABILITIES,
	codex: CODEX_CAPABILITIES,
};

/** `claude --model <alias>` — always resolves to the current model in that tier. */
export const CLAUDE_MODELS = CLAUDE_CAPABILITIES.map((m) => m.id);
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/** `agy --model "<name>"` — the *logical* model ids (reasoning is chosen separately). */
export const ANTIGRAVITY_MODELS = ANTIGRAVITY_CAPABILITIES.map((m) => m.id);
export type AntigravityModel = (typeof ANTIGRAVITY_MODELS)[number];

/** `codex --model <name>` — short identifiers from the Codex models list. */
export const CODEX_MODELS = CODEX_CAPABILITIES.map((m) => m.id);
export type CodexModel = (typeof CODEX_MODELS)[number];

/** Per-CLI known logical-model ids, keyed the same way `DEFAULT_COMMAND` is. */
export const AGENT_MODELS: Readonly<Record<AgentCli, readonly string[]>> = {
	claude: CLAUDE_MODELS,
	antigravity: ANTIGRAVITY_MODELS,
	codex: CODEX_MODELS,
};

/** Every known logical model across all CLIs — used when a config doesn't pin `cli`. */
export const ALL_AGENT_MODELS: readonly string[] = [
	...CLAUDE_MODELS,
	...ANTIGRAVITY_MODELS,
	...CODEX_MODELS,
];

/** Coded default logical model per agent CLI when no configuration overrides it. */
export const DEFAULT_MODEL_PER_CLI: Record<AgentCli, string> = {
	claude: 'sonnet',
	antigravity: 'gemini-3.5-flash',
	codex: 'gpt-5.6-terra',
};

/**
 * Every combined `agy models` slug SWARM can launch (`gemini-3.6-flash-high`,
 * `claude-sonnet-4-6`, …) — the exact strings agy 1.1.5+ accepts on `--model`.
 * Derived from the capabilities so it can't drift from what `resolveModelLaunch`
 * emits; `splitAntigravityModel` decomposes any of them back into logical model
 * + reasoning.
 */
export const ANTIGRAVITY_MODEL_SLUGS: readonly string[] = ANTIGRAVITY_CAPABILITIES.flatMap((m) =>
	m.fixedVariant ? [m.fixedVariant] : Object.values(m.variantByReasoning ?? {}),
);

/**
 * Retired pre-1.1.5 agy display strings (`"Gemini 3.5 Flash (High)"`) that
 * pre-#180 SWARM configs stored in `AgentConfig.model` before reasoning became a
 * separate field. agy's model list no longer contains them, so they are never a
 * launch target — but the config schema still accepts them and
 * `splitAntigravityModel` migrates them losslessly to logical model + reasoning
 * (which then launches today's slug), so those configs keep working (issue #180,
 * #409).
 */
export const LEGACY_ANTIGRAVITY_DISPLAY_STRINGS: Readonly<
	Record<string, { model: string; reasoning?: ReasoningLevel }>
> = {
	'Gemini 3.5 Flash (Low)': { model: 'gemini-3.5-flash', reasoning: 'low' },
	'Gemini 3.5 Flash (Medium)': { model: 'gemini-3.5-flash', reasoning: 'medium' },
	'Gemini 3.5 Flash (High)': { model: 'gemini-3.5-flash', reasoning: 'high' },
	'Gemini 3.6 Flash (Low)': { model: 'gemini-3.6-flash', reasoning: 'low' },
	'Gemini 3.6 Flash (Medium)': { model: 'gemini-3.6-flash', reasoning: 'medium' },
	'Gemini 3.6 Flash (High)': { model: 'gemini-3.6-flash', reasoning: 'high' },
	'Gemini 3.1 Pro (Low)': { model: 'gemini-3.1-pro', reasoning: 'low' },
	'Gemini 3.1 Pro (High)': { model: 'gemini-3.1-pro', reasoning: 'high' },
	'Claude Sonnet 4.6 (Thinking)': { model: 'claude-sonnet-4.6' },
	'Claude Opus 4.6 (Thinking)': { model: 'claude-opus-4.6' },
	'GPT-OSS 120B (Medium)': { model: 'gpt-oss-120b' },
};

/** Look up a logical model's capability, or `undefined` if unknown for that CLI. */
export function capabilityFor(cli: AgentCli, model: string): ModelCapability | undefined {
	return MODEL_CAPABILITIES[cli]?.find((m) => m.id === model);
}

/** The normalized reasoning levels a (cli, model) supports — empty if none/unknown. */
export function reasoningChoicesFor(cli: AgentCli, model: string): readonly ReasoningLevel[] {
	return capabilityFor(cli, model)?.reasoningChoices ?? [];
}

/**
 * Decompose a combined antigravity model string into a logical model id plus
 * reasoning level (or no level, for a fixed single-variant model). Recognizes
 * both today's `agy models` slug (`gemini-3.6-flash-high`) and the retired
 * pre-1.1.5 display string (`"Gemini 3.6 Flash (High)"`) a legacy config may
 * still carry. Returns `null` when the string isn't a recognized combined
 * variant — callers then treat the value as an already-logical id.
 */
export function splitAntigravityModel(
	model: string,
): { model: string; reasoning?: ReasoningLevel } | null {
	for (const cap of ANTIGRAVITY_CAPABILITIES) {
		if (cap.fixedVariant === model) return { model: cap.id };
		for (const [level, variant] of Object.entries(cap.variantByReasoning ?? {})) {
			if (variant === model) return { model: cap.id, reasoning: level as ReasoningLevel };
		}
	}
	const legacy = LEGACY_ANTIGRAVITY_DISPLAY_STRINGS[model];
	return legacy ? { ...legacy } : null;
}

/**
 * Normalize a stored `(cli, model)` selection into `{ model: logicalId, reasoning? }`.
 * For antigravity this decomposes a legacy combined string; for every other case
 * the model passes through unchanged and no reasoning is inferred. Used by the
 * config schema and the dashboard so old blobs and new selections share one shape.
 */
export function normalizeModelSelection(
	cli: AgentCli | undefined,
	model: string,
): { model: string; reasoning?: ReasoningLevel } {
	if (cli === 'antigravity') {
		const split = splitAntigravityModel(model);
		if (split) return split;
	}
	return { model };
}

/** The concrete launch parameters for a (cli, model, reasoning) selection. */
export interface ModelLaunch {
	/** Value passed to `--model`. */
	model: string;
	/** Extra provider args (`--effort …`, `-c model_reasoning_effort=…`), possibly empty. */
	providerArgs: string[];
}

/**
 * Resolve how a `(cli, model, reasoning)` selection launches — the per-CLI
 * boundary where the normalized reasoning level becomes provider-specific argv.
 *
 * - claude → `{ model, providerArgs: reasoning ? ['--effort', level] : [] }`
 * - codex  → `{ model, providerArgs: reasoning ? ['-c', 'model_reasoning_effort="level"'] : [] }`
 * - antigravity → the combined `agy models` slug in `model`, no provider args.
 *   A combined string already in `model` — today's slug, or a retired pre-1.1.5
 *   display string a legacy config carries — is decomposed and re-resolved to the
 *   current slug, so we never send agy a name its model list no longer contains.
 *   Otherwise the logical id + reasoning (or the model's default / fixed variant)
 *   re-combine; an unknown logical id falls through to `model` verbatim so `agy`
 *   itself fails visibly rather than us silently substituting.
 *
 * Throws only when an antigravity logical model is known but the requested
 * reasoning maps to no real variant — failing visibly per issue #180 rather
 * than launching a different model.
 */
export function resolveModelLaunch(
	cli: AgentCli,
	model: string | undefined,
	reasoning: ReasoningLevel | undefined,
): ModelLaunch {
	if (!model) return { model: '', providerArgs: [] };

	if (cli === 'claude') {
		return { model, providerArgs: reasoning ? ['--effort', reasoning] : [] };
	}
	if (cli === 'codex') {
		return {
			model,
			providerArgs: reasoning ? ['-c', `model_reasoning_effort="${reasoning}"`] : [],
		};
	}

	// antigravity: reasoning is encoded in the model slug, never a flag. If `model`
	// is itself a combined string (today's slug or a legacy display string),
	// decompose it so a retired display string re-resolves to the current slug; an
	// explicit combined string wins over a separately-passed reasoning level.
	const combined = splitAntigravityModel(model);
	const logicalId = combined?.model ?? model;
	const level = combined?.reasoning ?? reasoning;
	const cap = capabilityFor('antigravity', logicalId);
	if (!cap) return { model, providerArgs: [] };
	if (cap.fixedVariant) return { model: cap.fixedVariant, providerArgs: [] };
	const chosen = level ?? cap.defaultReasoning ?? undefined;
	const slug = chosen ? cap.variantByReasoning?.[chosen] : undefined;
	if (!slug) {
		throw new Error(
			`antigravity model '${logicalId}' has no variant for reasoning '${chosen ?? 'default'}'`,
		);
	}
	return { model: slug, providerArgs: [] };
}
