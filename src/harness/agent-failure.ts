/**
 * Agent-run failure classification — the reusable half of "detect a rate/usage
 * limit and retry the phase once quota is back" (issue #91).
 *
 * The harness ({@link ./agent-cli.ts}) treats a non-zero exit as a normal
 * resolved result and never inspects its output; every pipeline phase then turns
 * that into a generic `... exited with code N` error. That makes a transient
 * usage/session-limit hit — where the agent never got to do any work — look
 * identical to the agent running and producing something wrong, so the worker
 * fails the job terminally instead of waiting out the limit.
 *
 * This module is where the CLI-specific knowledge of *what a limit looks like*
 * lives, mirroring how {@link ./agent-cli.ts} owns the per-CLI flag quirks: it
 * reads an {@link AgentCliResult} and says whether the failure is a `rate-limit`
 * (retry later), a `timeout` (the harness killed it), or a plain `error`. For a
 * rate-limit it also lifts the CLI's own "resets …" hint out of the output and,
 * best-effort, resolves it to an absolute instant the worker can defer until.
 */

import type { AgentCliResult } from './agent-cli.js';

/** Why an agent run failed, from the worker's point of view. */
export type AgentFailureKind = 'rate-limit' | 'timeout' | 'error';

export interface AgentFailure {
	kind: AgentFailureKind;
	/**
	 * The CLI's verbatim "resets …" text (e.g. `1:40pm (Europe/Warsaw)`), kept
	 * for logs/PR comments even when {@link retryAfter} can't be resolved.
	 */
	resetHint?: string;
	/**
	 * Best-effort absolute instant the limit resets, parsed from {@link resetHint}.
	 * Undefined when the hint carries no timezone or can't be parsed — the caller
	 * falls back to a default backoff.
	 */
	retryAfter?: Date;
}

/**
 * Error thrown by a pipeline phase when its agent run failed, carrying the
 * {@link AgentFailure} classification so the worker's consumer can tell a
 * transient rate-limit (defer + retry) apart from a terminal failure without
 * re-parsing a message string.
 */
export class AgentRunError extends Error {
	readonly failure: AgentFailure;
	constructor(message: string, failure: AgentFailure) {
		super(message);
		this.name = 'AgentRunError';
		this.failure = failure;
	}
}

// The distinctive shapes of an agent CLI's own usage/session-limit banner. Kept
// deliberately tight: an ordinary failed run whose output merely *discusses*
// rate limiting (say, a review of code about it) must not be misread as the CLI
// itself being limited. Only the literal "you've hit your … limit" phrasing
// stands on its own; the softer signals — a bare "usage limit" mention, or an
// HTTP `429`/"too many requests" — fire only when a "resets …" line co-occurs.
// This matters because classification scans the agent's *full output* on any
// non-zero exit (see runAgentCli, which already filters successes): the
// respond-to-ci phase feeds the agent CI logs that routinely contain e.g. Docker
// Hub's `429 Too Many Requests` / pull-rate-limit text, and reviewing code that
// handles HTTP 429 is similar. A standalone 429 in that borrowed text must not
// be misread as the CLI itself being rate-limited (and retried up to 6×).
const LIMIT_BANNER_RE = /(?:you've|you have)\s+hit\s+your\s+(?:session|usage|rate)\s+limit/i;
const USAGE_LIMIT_RE = /\b(?:session|usage|rate)[\s-]?limit\b/i;
const RATE_HTTP_RE = /\b(?:429|too many requests)\b/i;
const RESET_RE = /resets?\s+([^\n]+)/i;
// A clock time optionally followed by a parenthesised IANA timezone, e.g.
// `1:40pm (Europe/Warsaw)` or `13:40 (Europe/Warsaw)`.
const RESET_TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:[^\n(]*\(([^)]+)\))?/i;

/** Compute a timezone's UTC offset (ms) at a given instant via the Intl trick. */
function tzOffsetMs(instant: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(instant);
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour'),
		get('minute'),
		get('second'),
	);
	return asUtc - instant.getTime();
}

/** The UTC instant whose wall-clock reading in `timeZone` is the given Y-M-D H:M. */
function zonedWallTimeToUtc(
	year: number,
	month1: number,
	day: number,
	hour24: number,
	minute: number,
	timeZone: string,
): Date {
	const naiveUtc = Date.UTC(year, month1 - 1, day, hour24, minute, 0);
	return new Date(naiveUtc - tzOffsetMs(new Date(naiveUtc), timeZone));
}

/**
 * Resolve a "resets …" hint like `1:40pm (Europe/Warsaw)` to the next instant
 * that wall-clock time occurs in that timezone, relative to `now`. Returns
 * undefined if the hint lacks a timezone or anything fails to parse — the reset
 * time is unknowable without the zone, and a wrong guess is worse than a
 * default backoff. Never throws (an invalid timezone makes Intl throw).
 */
function parseRetryAfter(hint: string, now: Date): Date | undefined {
	try {
		const match = RESET_TIME_RE.exec(hint);
		if (!match) return undefined;
		const [, rawHour, rawMinute, meridiem, timeZone] = match;
		if (!timeZone) return undefined;

		let hour = Number(rawHour);
		const minute = rawMinute ? Number(rawMinute) : 0;
		if (meridiem) {
			const pm = meridiem.toLowerCase() === 'pm';
			if (hour === 12) hour = pm ? 12 : 0;
			else if (pm) hour += 12;
		}
		if (hour > 23 || minute > 59) return undefined;

		// Today's date *in the target zone* — the reset time is a wall clock there.
		const dateParts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(now);
		const get = (type: string): number => Number(dateParts.find((p) => p.type === type)?.value);
		let target = zonedWallTimeToUtc(get('year'), get('month'), get('day'), hour, minute, timeZone);
		// A reset that already passed today means the next occurrence is tomorrow.
		// Adding a fixed 24h (rather than re-deriving tomorrow's wall time) can skew
		// the instant by an hour across a DST boundary — harmless here: the reset is
		// only a hint, and the consumer buffers + clamps the delay to [6min, 6h].
		if (target.getTime() <= now.getTime()) {
			target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
		}
		return target;
	} catch {
		return undefined;
	}
}

/**
 * Classify a failed agent run. `now` is injectable so the reset-time parse is
 * deterministic under test. A timed-out run is a `timeout` regardless of what it
 * printed (the harness killing it is the authoritative cause); otherwise a
 * recognisable limit banner makes it a `rate-limit`, and everything else is a
 * plain `error`.
 */
export function classifyAgentFailure(result: AgentCliResult, now: Date = new Date()): AgentFailure {
	if (result.timedOut) return { kind: 'timeout' };

	const output = `${result.stdout}\n${result.stderr}`;
	const resetMatch = RESET_RE.exec(output);
	const isRateLimited =
		LIMIT_BANNER_RE.test(output) ||
		((USAGE_LIMIT_RE.test(output) || RATE_HTTP_RE.test(output)) && resetMatch !== null);

	if (!isRateLimited) return { kind: 'error' };

	const resetHint = resetMatch?.[1]?.trim() || undefined;
	return {
		kind: 'rate-limit',
		resetHint,
		retryAfter: resetHint ? parseRetryAfter(resetHint, now) : undefined,
	};
}

/**
 * Build the {@link AgentRunError} a pipeline phase throws on a non-zero exit.
 * `prefix` is the phase-specific stem (`Review agent (claude) exited with code
 * 1`) and `tail` its suffix (` for PR #90`); this splices in a reason marker so
 * the message reads `… exited with code 1 (rate limited) for PR #90`, and
 * attaches the classification for the consumer to act on.
 */
export function agentRunError(
	result: AgentCliResult,
	prefix: string,
	tail = '',
	now: Date = new Date(),
): AgentRunError {
	const failure = classifyAgentFailure(result, now);
	const reason =
		failure.kind === 'timeout'
			? ' (timed out)'
			: failure.kind === 'rate-limit'
				? ' (rate limited)'
				: '';
	return new AgentRunError(`${prefix}${reason}${tail}`, failure);
}
