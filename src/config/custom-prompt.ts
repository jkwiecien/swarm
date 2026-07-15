/**
 * The per-phase custom-prompt bound and its normalizer (issue #135), factored
 * into a dependency-free leaf so both the config schema (server) and the web
 * dashboard can import them. `src/config/schema.ts` pulls in Node-only modules
 * (via the agent-cli schema), so the web bundle must not reach the constant
 * through it — this module carries no such dependency.
 */

/**
 * Upper bound on a per-phase custom prompt (`agents.<phase>.prompt`), in
 * characters. Bounds the extra text appended to a phase's CLI prompt so a
 * pathological config can't blow up the agent invocation. Checked against the
 * *normalized* (trimmed) value.
 */
export const CUSTOM_PROMPT_MAX_LENGTH = 10_000;

/**
 * Normalize a per-phase custom prompt: trim surrounding whitespace and treat a
 * blank (or whitespace-only) value as unset. Whitespace-only input must not be
 * stored or composed as a meaningful override, so it collapses to `undefined`
 * here — the one place the config schema, the prompt composer, and the dashboard
 * all agree on what "no custom prompt" means.
 */
export function normalizeCustomPrompt(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
