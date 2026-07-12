/**
 * Normalized per-run token usage (issue #138) — the shape that crosses both
 * the agent-CLI stdout boundary and the `runs.usage` DB boundary, so it gets a
 * Zod schema (ai/CODING_STANDARDS.md "Zod is the source of truth"); the TS
 * type is inferred from it.
 *
 * Usage extraction is per-CLI (each CLI reports its own output shape, if any
 * — ai/RULES.md §6 "don't assume identical flag/output semantics"). Only
 * `claude` and `codex` are implemented here. Antigravity cannot emit
 * structured usage, so it intentionally returns the graceful "usage
 * unavailable" result.
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
	// The session UUID this run used — the same value SWARM assigned via
	// `--session-id`, echoed back so a resume can reuse it even if the assignment
	// path ever changes. Optional: an older `claude` build that omits it still
	// parses (SWARM falls back to the id it assigned).
	session_id: z.string().optional(),
	usage: z.object({
		input_tokens: z.number(),
		output_tokens: z.number(),
		cache_read_input_tokens: z.number().optional(),
		cache_creation_input_tokens: z.number().optional(),
	}),
});

const CodexUsageSchema = z.object({
	input_tokens: z.number(),
	output_tokens: z.number(),
	cached_input_tokens: z.number().optional(),
	reasoning_output_tokens: z.number().optional(),
});

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function codexAgentMessage(event: Record<string, unknown>): string | undefined {
	if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') {
		return undefined;
	}
	const item = event.item as Record<string, unknown>;
	return item.type === 'agent_message' && typeof item.text === 'string' ? item.text : undefined;
}

function collectCodexEvents(stdout: string): {
	rawUsage?: z.infer<typeof CodexUsageSchema>;
	messages: string[];
	sessionId?: string;
} {
	let rawUsage: z.infer<typeof CodexUsageSchema> | undefined;
	let sessionId: string | undefined;
	const messages: string[] = [];
	for (const line of stdout.split('\n')) {
		const event = parseJsonLine(line);
		if (!event) continue;
		// `codex exec --json` emits `{"type":"thread.started","thread_id":"…"}` as
		// its first event; the thread id is what `codex exec resume <id>` takes to
		// continue the same session (verified live). A resume run re-emits the same
		// id, so capturing it on every run keeps the row's session handle current.
		if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
			sessionId = event.thread_id;
		}
		if (event.type === 'turn.completed') {
			const parsedUsage = CodexUsageSchema.safeParse(event.usage);
			if (parsedUsage.success) rawUsage = parsedUsage.data;
		}
		const message = codexAgentMessage(event);
		if (message !== undefined) messages.push(message);
	}
	return { rawUsage, messages, sessionId };
}

export interface ParsedAgentOutput {
	/** Normalized token usage, or absent when the CLI's output couldn't be read. */
	usage?: AgentUsage;
	/**
	 * The human-readable text to keep as the run's log (unchanged from the
	 * plain-text stdout the log viewer showed before this feature). Absent
	 * means "keep whatever raw stdout the caller already captured".
	 */
	logText?: string;
	/**
	 * The CLI session/thread id recovered from this run's output, to resume it
	 * later. Only `claude` (`session_id`) and `codex` (`thread.started`) emit one
	 * on stdout; Antigravity does not (it's captured out-of-band — see
	 * `./antigravity-session.ts`), so this is absent for it.
	 */
	sessionId?: string;
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

	const { result: logText, session_id: sessionId, usage: rawUsage } = outer.data;
	const usage = AgentUsageSchema.safeParse({
		inputTokens: rawUsage.input_tokens,
		outputTokens: rawUsage.output_tokens,
		cacheReadTokens: rawUsage.cache_read_input_tokens,
		cacheCreationTokens: rawUsage.cache_creation_input_tokens,
	});
	if (!usage.success) return { logText, sessionId };

	return { usage: usage.data, logText, sessionId };
}

/** Parse the JSONL event stream emitted by `codex exec --json`. */
function parseCodexOutput(stdout: string): ParsedAgentOutput {
	const { rawUsage, messages, sessionId } = collectCodexEvents(stdout);
	const logText = messages.length > 0 ? messages.join('\n') : undefined;
	const base = {
		...(logText === undefined ? {} : { logText }),
		...(sessionId === undefined ? {} : { sessionId }),
	};
	if (!rawUsage) return base;

	// Codex input_tokens includes cached input; preserve both reported values
	// independently rather than subtracting cached_input_tokens from the total.
	const usage = AgentUsageSchema.safeParse({
		inputTokens: rawUsage.input_tokens,
		outputTokens: rawUsage.output_tokens,
		cacheReadTokens: rawUsage.cached_input_tokens,
		reasoningTokens: rawUsage.reasoning_output_tokens,
	});
	if (!usage.success) return base;

	return { usage: usage.data, ...base };
}

/**
 * Parse a completed CLI run's captured stdout into normalized usage plus the
 * human-readable text to keep in the run log. Dispatches per `cli`.
 */
export function parseAgentOutput(cli: AgentCli, stdout: string): ParsedAgentOutput {
	switch (cli) {
		case 'claude':
			return parseClaudeOutput(stdout);
		case 'antigravity':
			// agy has no structured/usage output flag (verified live, ai/RULES.md §6),
			// so usage is unavailable by design.
			return {};
		case 'codex':
			return parseCodexOutput(stdout);
	}
}
