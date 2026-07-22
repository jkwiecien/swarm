/**
 * Claude's `--output-format stream-json` protocol — decoded into the readable
 * lines SWARM shows as live run output, plus the terminal `result` record the
 * harness reads a run's final text, session id, and usage from.
 *
 * `--output-format json` prints a single final document, which Claude buffers
 * until the process exits: a 17-minute run showed an empty live log and emitted
 * exactly one output event, at termination (issue #356). Streaming mode instead
 * emits one NDJSON record per protocol event, so the harness can forward
 * progress as it happens.
 *
 * Only the fields SWARM consumes are modelled (ai/CODING_STANDARDS.md "Zod is
 * the source of truth"); unknown record types and unknown fields are ignored so
 * a newer Claude build extending the protocol degrades to "less detail", never
 * to a broken decoder. Tool *inputs* and tool *results* are deliberately never
 * rendered — they carry file contents, command output, and credentials that
 * must not reach the run page; only the tool's name and outcome are.
 */

import { z } from 'zod';

/**
 * Prefix of the single line a failed terminal `result` event is rendered as.
 * Load-bearing: failure classification (`./agent-failure.ts`) treats a line with
 * this prefix as a structural error signal rather than as free text an agent
 * might merely be quoting.
 */
export const CLAUDE_ERROR_PREFIX = 'Claude run failed';

/** Cap on the rendered detail of a terminal error, so one line stays one line. */
const MAX_ERROR_DETAIL_CHARS = 2_000;

/**
 * How many in-flight `tool_use_id` → tool-name entries the normalizer tracks.
 * Entries are dropped as their tool completes; the cap bounds the leak from
 * tools whose result never appears on the main stream (a killed run, a
 * sub-agent's private turn).
 */
const MAX_TRACKED_TOOLS = 200;

const ClaudeStreamUsageSchema = z.object({
	input_tokens: z.number(),
	output_tokens: z.number(),
	cache_read_input_tokens: z.number().optional(),
	cache_creation_input_tokens: z.number().optional(),
});

/**
 * The terminal `result` record — the last event of a print-mode stream, and the
 * only one carrying the run's final text, session id, and token usage. Every
 * field but `type` is optional: an errored run reports the same record shape
 * with `is_error` set and, depending on how it failed, no `result`/`usage`.
 */
const ClaudeResultEventSchema = z.object({
	type: z.literal('result'),
	subtype: z.string().optional(),
	is_error: z.boolean().optional(),
	result: z.string().optional(),
	session_id: z.string().optional(),
	usage: ClaudeStreamUsageSchema.optional(),
	error: z.unknown().optional(),
});
export type ClaudeResultEvent = z.infer<typeof ClaudeResultEventSchema>;

/**
 * Claude reports its own usage-window state as it goes, in `rate_limit_event`
 * records (confirmed live: `{"type":"rate_limit_event","rate_limit_info":
 * {"status":"allowed","resetsAt":1784755200,"rateLimitType":"five_hour",…}}`).
 * `resetsAt` is Unix seconds — an exact instant, unlike the human "resets
 * 1:40pm (Europe/Warsaw)" hint a limit banner carries, which is unusable
 * without its timezone.
 */
const ClaudeRateLimitEventSchema = z.object({
	type: z.literal('rate_limit_event'),
	rate_limit_info: z.object({ resetsAt: z.number() }),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Parse one NDJSON line, or undefined when it isn't a JSON object. */
function parseEvent(line: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/** The content blocks of an `assistant`/`user` event, ignoring other shapes. */
function contentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
	const content = asRecord(event.message)?.content;
	if (!Array.isArray(content)) return [];
	return content.map(asRecord).filter((block): block is Record<string, unknown> => Boolean(block));
}

/** True when a terminal `result` event reports a failed run rather than a completed one. */
export function isClaudeErrorResult(event: ClaudeResultEvent): boolean {
	return event.is_error === true || (event.subtype !== undefined && event.subtype !== 'success');
}

export function errorDetail(error: unknown): string | undefined {
	if (typeof error === 'string') return error;
	const message = asRecord(error)?.message;
	return typeof message === 'string' ? message : undefined;
}

/**
 * Render a failed terminal `result` event as exactly one line. It carries every
 * textual signal the event had (its subtype, its `result` text, its `error`
 * message), because that text is what tells a rate limit, an overloaded model,
 * and an ordinary failure apart downstream (`./agent-failure.ts`) — the same
 * strings the raw final JSON used to expose before streaming.
 */
export function formatClaudeResultError(event: ClaudeResultEvent): string {
	const detail = [event.result, errorDetail(event.error)]
		.map((part) => part?.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join(' ')
		.slice(0, MAX_ERROR_DETAIL_CHARS);
	return `${CLAUDE_ERROR_PREFIX} (${event.subtype ?? 'error'}): ${detail || 'no detail reported'}`;
}

/**
 * The terminal `result` record of a captured stream, or undefined when the run
 * never produced one (killed, timed out, or its record fell outside the
 * retained window). Scans line by line and ignores anything unparseable, so a
 * capture that starts mid-record — the rolling tail the harness keeps when a
 * chatty run floods its head buffer — still yields the record it contains.
 */
export function findClaudeResultEvent(stdout: string): ClaudeResultEvent | undefined {
	let found: ClaudeResultEvent | undefined;
	for (const line of stdout.split('\n')) {
		const event = parseEvent(line);
		if (!event || event.type !== 'result') continue;
		const parsed = ClaudeResultEventSchema.safeParse(event);
		if (parsed.success) found = parsed.data;
	}
	return found;
}

/**
 * When Claude's usage window last reported it resets, or undefined when the
 * stream carried no such record. Only meaningful for a run that *was* rate
 * limited — for a healthy run this is just the current window's boundary — so
 * failure classification consults it only after classifying a rate limit.
 */
export function findClaudeRateLimitReset(stdout: string): Date | undefined {
	let resetsAt: number | undefined;
	for (const line of stdout.split('\n')) {
		const event = parseEvent(line);
		if (!event || event.type !== 'rate_limit_event') continue;
		const parsed = ClaudeRateLimitEventSchema.safeParse(event);
		if (parsed.success) resetsAt = parsed.data.rate_limit_info.resetsAt;
	}
	return resetsAt === undefined ? undefined : new Date(resetsAt * 1_000);
}

export interface ClaudeStreamNormalizer {
	/**
	 * Readable display lines for one raw stdout line — zero for protocol records
	 * SWARM doesn't surface (init, thinking, control, unknown types).
	 */
	translate(line: string): string[];
}

/**
 * Stateful decoder for one run's stream. It holds two things across events: the
 * in-flight tool names (a `tool_result` names only the id its `tool_use`
 * announced), and the last assistant text, so a successful terminal `result` —
 * which repeats that text — isn't shown twice.
 */
export function createClaudeStreamNormalizer(): ClaudeStreamNormalizer {
	const toolNames = new Map<string, string>();
	let lastAssistantText: string | undefined;

	const rememberTool = (id: string, name: string): void => {
		if (toolNames.size >= MAX_TRACKED_TOOLS) {
			const oldest = toolNames.keys().next().value;
			if (oldest !== undefined) toolNames.delete(oldest);
		}
		toolNames.set(id, name);
	};

	const assistantLines = (event: Record<string, unknown>): string[] => {
		const lines: string[] = [];
		for (const block of contentBlocks(event)) {
			if (block.type === 'text' && typeof block.text === 'string') {
				const text = block.text.trim();
				if (!text) continue;
				lastAssistantText = text;
				lines.push(
					...text
						.split('\n')
						.map((line) => line.trimEnd())
						.filter(Boolean),
				);
			} else if (
				block.type === 'tool_use' &&
				typeof block.id === 'string' &&
				typeof block.name === 'string'
			) {
				rememberTool(block.id, block.name);
				lines.push(`Tool started: ${block.name}`);
			}
		}
		return lines;
	};

	// A `user` event is either the prompt echoed back or the results of the tools
	// the previous assistant turn called. Only the latter is reported, and only
	// as an outcome — never the result payload, and never for a tool this run
	// didn't announce (a sub-agent's own turn), which would read as noise.
	const toolResultLines = (event: Record<string, unknown>): string[] => {
		const lines: string[] = [];
		for (const block of contentBlocks(event)) {
			if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
			const name = toolNames.get(block.tool_use_id);
			if (name === undefined) continue;
			toolNames.delete(block.tool_use_id);
			lines.push(`${block.is_error === true ? 'Tool failed' : 'Tool completed'}: ${name}`);
		}
		return lines;
	};

	const resultLines = (event: Record<string, unknown>): string[] => {
		const parsed = ClaudeResultEventSchema.safeParse(event);
		if (!parsed.success) return [];
		if (isClaudeErrorResult(parsed.data)) return [formatClaudeResultError(parsed.data)];
		const text = parsed.data.result?.trim();
		return text && text !== lastAssistantText ? text.split('\n').filter(Boolean) : [];
	};

	return {
		translate(raw: string): string[] {
			const line = raw.trim();
			if (!line) return [];
			const event = parseEvent(line);
			if (!event) {
				// Plain text on stdout is a CLI message printed outside the protocol (a
				// startup or auth failure) and is kept verbatim. A JSON-shaped line that
				// didn't parse is a truncated/oversized protocol record — dropped, so no
				// raw protocol fragment ever reaches the run page.
				return line.startsWith('{') || line.startsWith('[') ? [] : [line];
			}
			switch (event.type) {
				case 'assistant':
					return assistantLines(event);
				case 'user':
					return toolResultLines(event);
				case 'result':
					return resultLines(event);
				default:
					return [];
			}
		},
	};
}
