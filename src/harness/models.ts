/**
 * Known models per agent CLI — the single source of truth for what
 * `AgentConfig.model` (`src/config/schema.ts`) accepts, and, later, what a
 * dashboard UI offers as per-phase choices (the phase-6 web-dashboard backlog,
 * issues #75-86).
 *
 * `claude`'s list is short aliases, not full model IDs: `claude --help` —
 * "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')
 * or a model's full name (e.g. 'claude-fable-5')." Aliases always point at the
 * current model in that tier, which is what a config should want rather than
 * pinning a dated ID that ages out.
 *
 * `antigravity`'s list is the exact display strings `agy models` prints —
 * confirmed live on this machine — since that's what its `--model` flag
 * expects verbatim (e.g. "Gemini 3.5 Flash (High)"), not a short alias.
 *
 * `codex`'s list is the short model identifiers shown by `codex` (the first
 * token on each line of the models picker) — confirmed live from the user's
 * own output. Codex's `--model` / `-m` flag accepts these verbatim (e.g.
 * `gpt-5.6-sol`, `gpt-5.4-mini`).
 */

import type { AgentCli } from './agent-cli.js';

/** `claude --model <alias>` — always resolves to the current model in that tier. */
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/** `agy --model "<name>"` — exact strings from `agy models`, quoted verbatim. */
export const ANTIGRAVITY_MODELS = [
	'Gemini 3.5 Flash (Low)',
	'Gemini 3.5 Flash (Medium)',
	'Gemini 3.5 Flash (High)',
	'Gemini 3.1 Pro (Low)',
	'Gemini 3.1 Pro (High)',
	'Claude Sonnet 4.6 (Thinking)',
	'Claude Opus 4.6 (Thinking)',
	'GPT-OSS 120B (Medium)',
] as const;
export type AntigravityModel = (typeof ANTIGRAVITY_MODELS)[number];

/** `codex --model <name>` — short identifiers from the Codex models list. */
export const CODEX_MODELS = [
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'gpt-5.5',
	'gpt-5.4',
	'gpt-5.4-mini',
] as const;
export type CodexModel = (typeof CODEX_MODELS)[number];

/** Per-CLI known-model list, keyed the same way `DEFAULT_COMMAND` (`agent-cli.ts`) is. */
export const AGENT_MODELS: Readonly<Record<AgentCli, readonly string[]>> = {
	claude: CLAUDE_MODELS,
	antigravity: ANTIGRAVITY_MODELS,
	codex: CODEX_MODELS,
};

/** Every known model across all CLIs — used when a config doesn't pin `cli`. */
export const ALL_AGENT_MODELS: readonly string[] = [
	...CLAUDE_MODELS,
	...ANTIGRAVITY_MODELS,
	...CODEX_MODELS,
];

/** Coded default models per agent CLI when no configuration overrides it. */
export const DEFAULT_MODEL_PER_CLI: Record<AgentCli, string> = {
	claude: 'sonnet',
	antigravity: 'Gemini 3.5 Flash (Medium)',
	codex: 'gpt-5.6-terra',
};
