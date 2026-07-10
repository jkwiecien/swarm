/**
 * Normalized per-run token usage (issue #138) — the shape that crosses both
 * the agent-CLI stdout boundary and the `runs.usage` DB boundary, so it gets a
 * Zod schema (ai/CODING_STANDARDS.md "Zod is the source of truth"); the TS
 * type is inferred from it.
 *
 * Usage extraction is per-CLI (each CLI reports its own output shape, if any
 * — ai/RULES.md §6 "don't assume identical flag/output semantics"). Only
 * `claude` is implemented here; `antigravity`/`codex` are a follow-up task and
 * fall through to the graceful "usage unavailable" result.
 */

import { z } from 'zod';
import type { AgentCli } from './agent-cli.js';

export const AgentUsageSchema = z.object({
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative().optional(),
	cacheCreationTokens: z.number().int().nonnegative().optional(),
	reasoningTokens: z.number().int().nonnegative().optional(),
	totalTokens: z.number().int().nonnegative().optional(),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

/**
 * The shape `claude -p --output-format json` prints on stdout: a single JSON
 * object whose `result` is the same final-assistant-text `-p` alone would have
 * printed, plus a `usage` object. `usage` is required in this schema — a
 * response missing it doesn't match Claude's documented JSON output closely
 * enough to trust, so it's treated the same as malformed JSON (see
 * {@link parseClaudeOutput}).
 */
const ClaudeJsonResultSchema = z.object({
	result: z.string(),
	usage: z.object({
		input_tokens: z.number(),
		output_tokens: z.number(),
		cache_read_input_tokens: z.number().optional(),
		cache_creation_input_tokens: z.number().optional(),
	}),
});

export interface ParsedAgentOutput {
	/** Normalized token usage, or absent when the CLI's output couldn't be read. */
	usage?: AgentUsage;
	/**
	 * The human-readable text to keep as the run's log (unchanged from the
	 * plain-text stdout the log viewer showed before this feature). Absent
	 * means "keep whatever raw stdout the caller already captured".
	 */
	logText?: string;
}

/**
 * Parse `claude -p --output-format json`'s stdout. On any failure — malformed
 * JSON, a truncated stream, or a response missing the `usage` field — returns
 * `{}` (usage unavailable, log text falls back to raw stdout); a parse
 * failure must never turn a successful agent run into a failed one.
 */
function parseClaudeOutput(stdout: string): ParsedAgentOutput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return {};
	}

	const outer = ClaudeJsonResultSchema.safeParse(parsed);
	if (!outer.success) return {};

	const { result: logText, usage: rawUsage } = outer.data;
	const usage = AgentUsageSchema.safeParse({
		inputTokens: rawUsage.input_tokens,
		outputTokens: rawUsage.output_tokens,
		cacheReadTokens: rawUsage.cache_read_input_tokens,
		cacheCreationTokens: rawUsage.cache_creation_input_tokens,
	});
	if (!usage.success) return { logText };

	return { usage: usage.data, logText };
}

/**
 * Parse a completed CLI run's captured stdout into normalized usage plus the
 * human-readable text to keep in the run log. Dispatches per `cli`;
 * `antigravity`/`codex` return `{}` until a follow-up task implements their
 * parsers (their output shape hasn't been live-verified yet, ai/RULES.md §6).
 */
export function parseAgentOutput(cli: AgentCli, stdout: string): ParsedAgentOutput {
	switch (cli) {
		case 'claude':
			return parseClaudeOutput(stdout);
		case 'antigravity':
		case 'codex':
			return {};
	}
}
