/**
 * Per-model capability metadata — the single source of truth for what
 * `AgentConfig.model` / `AgentConfig.reasoning` (`src/config/schema.ts`) accept,
 * and what the dashboard's per-phase Agent Configuration offers as choices
 * (the phase-6 web-dashboard backlog).
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
 *  - `antigravity`: no reasoning flag at all — the level is baked into the
 *    model *name* `agy models` prints (`"Gemini 3.5 Flash (High)"`), so a
 *    logical model + reasoning maps back to that exact combined variant string.
 *    Single-variant models (`Claude Sonnet 4.6 (Thinking)`, `GPT-OSS 120B
 *    (Medium)`) expose no reasoning choice — their variant is fixed.
 *
 * These are capability *inputs* observed on the current dev host, not a promise
 * that provider catalogs never change — hence the `LEGACY_ANTIGRAVITY_MODELS`
 * back-compat set (§below) and `resolveModelLaunch`'s fail-visibly behavior.
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
 * `agy --model "<combined>"`. The logical model + reasoning re-combine into the
 * exact `agy models` display string. Flash/Pro expose reasoning tiers; the
 * Claude/GPT-OSS entries are single fixed variants (no reasoning choice).
 */
const ANTIGRAVITY_CAPABILITIES: readonly ModelCapability[] = [
	{
		cli: 'antigravity',
		id: 'gemini-3.5-flash',
		label: 'Gemini 3.5 Flash',
		reasoningChoices: ['low', 'medium', 'high'],
		defaultReasoning: 'medium',
		variantByReasoning: {
			low: 'Gemini 3.5 Flash (Low)',
			medium: 'Gemini 3.5 Flash (Medium)',
			high: 'Gemini 3.5 Flash (High)',
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
			low: 'Gemini 3.1 Pro (Low)',
			high: 'Gemini 3.1 Pro (High)',
		},
	},
	{
		cli: 'antigravity',
		id: 'claude-sonnet-4.6',
		label: 'Claude Sonnet 4.6',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'Claude Sonnet 4.6 (Thinking)',
	},
	{
		cli: 'antigravity',
		id: 'claude-opus-4.6',
		label: 'Claude Opus 4.6',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'Claude Opus 4.6 (Thinking)',
	},
	{
		cli: 'antigravity',
		id: 'gpt-oss-120b',
		label: 'GPT-OSS 120B',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'GPT-OSS 120B (Medium)',
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
 * The exact `agy models` combined display strings previous configs stored in
 * `AgentConfig.model` (before reasoning was a separate field). Still accepted by
 * the config schema and recognized by `resolveModelLaunch`/`splitAntigravityModel`
 * so existing `"Gemini 3.5 Flash (High)"` selections migrate losslessly into
 * logical model + reasoning and keep launching that exact variant (issue #180).
 */
export const LEGACY_ANTIGRAVITY_MODELS: readonly string[] = ANTIGRAVITY_CAPABILITIES.flatMap((m) =>
	m.fixedVariant ? [m.fixedVariant] : Object.values(m.variantByReasoning ?? {}),
);

/** Look up a logical model's capability, or `undefined` if unknown for that CLI. */
export function capabilityFor(cli: AgentCli, model: string): ModelCapability | undefined {
	return MODEL_CAPABILITIES[cli]?.find((m) => m.id === model);
}

/** The normalized reasoning levels a (cli, model) supports — empty if none/unknown. */
export function reasoningChoicesFor(cli: AgentCli, model: string): readonly ReasoningLevel[] {
	return capabilityFor(cli, model)?.reasoningChoices ?? [];
}

/**
 * Decompose a legacy combined antigravity model string into a logical model id
 * plus reasoning level (or no level, for a fixed single-variant model). Returns
 * `null` when the string isn't a recognized combined variant — callers then
 * treat the value as an already-logical id.
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
	return null;
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
 * - antigravity → the combined `agy models` string in `model`, no provider args.
 *   A legacy combined string in `model` is passed through verbatim (lossless
 *   back-compat). Otherwise the logical id + reasoning (or the model's default /
 *   fixed variant) re-combine; an unknown logical id falls through to `model`
 *   verbatim so `agy` itself fails visibly rather than us silently substituting.
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

	// antigravity: reasoning is encoded in the model string, never a flag.
	if ((LEGACY_ANTIGRAVITY_MODELS as readonly string[]).includes(model)) {
		return { model, providerArgs: [] };
	}
	const cap = capabilityFor('antigravity', model);
	if (!cap) return { model, providerArgs: [] };
	if (cap.fixedVariant) return { model: cap.fixedVariant, providerArgs: [] };
	const level = reasoning ?? cap.defaultReasoning ?? undefined;
	const variant = level ? cap.variantByReasoning?.[level] : undefined;
	if (!variant) {
		throw new Error(
			`antigravity model '${model}' has no variant for reasoning '${level ?? 'default'}'`,
		);
	}
	return { model: variant, providerArgs: [] };
}
