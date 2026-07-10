import { describe, expect, it } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError, agentRunError, classifyAgentFailure } from '@/harness/agent-failure.js';

function result(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 1,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1000,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		...overrides,
	};
}

// A fixed reference instant so the reset-time parse is deterministic. This is
// 2026-07-07T10:00:00Z, i.e. 12:00 in Europe/Warsaw (UTC+2 in July).
const NOW = new Date('2026-07-07T10:00:00Z');

describe('classifyAgentFailure', () => {
	it('classifies the observed Claude session-limit banner as rate-limit', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n" }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
	});

	it('resolves the reset hint to the next occurrence of that wall-clock time in its zone', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n" }),
			NOW,
		);
		// 1:40pm Warsaw (UTC+2 in July) == 11:40Z, later today than NOW (10:00Z).
		expect(failure.retryAfter?.toISOString()).toBe('2026-07-07T11:40:00.000Z');
	});

	it('rolls a reset time that already passed today to tomorrow', () => {
		// 9:00am Warsaw == 07:00Z, before NOW (10:00Z) → next is tomorrow.
		const failure = classifyAgentFailure(
			result({ stdout: 'usage limit reached — resets 9:00am (Europe/Warsaw)\n' }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.retryAfter?.toISOString()).toBe('2026-07-08T07:00:00.000Z');
	});

	it('detects a rate-limit from stderr too (429 co-occurring with a reset line)', () => {
		// An HTTP 429 is only a limit signal when a "resets …" line co-occurs — that
		// pairing is the CLI's own banner, not borrowed text. The scan reads stdout
		// and stderr as one blob, so the reset can arrive on either stream.
		const failure = classifyAgentFailure(
			result({ stderr: 'HTTP 429 Too Many Requests\nresets 1:40pm (Europe/Warsaw)' }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
	});

	it('does not treat a bare HTTP 429 (no reset line) as a rate-limit', () => {
		// A standalone 429 with no reset hint is a plain error — it may well be the
		// CLI's own transport hiccup, but without the reset banner it's
		// indistinguishable from borrowed text and must fail fast, not defer.
		expect(classifyAgentFailure(result({ stderr: 'HTTP 429 Too Many Requests' }), NOW).kind).toBe(
			'error',
		);
	});

	it('does not treat a Docker Hub 429 in CI logs as the CLI being rate-limited', () => {
		// The respond-to-ci phase feeds the agent CI logs; a Docker Hub pull-rate
		// 429 in that borrowed output must not defer + retry the phase 6× — the
		// exact false positive the co-occurrence gate guards against.
		const failure = classifyAgentFailure(
			result({
				stdout:
					'toomanyrequests: You have reached your pull rate limit.\n' +
					'  See https://www.docker.com/increase-rate-limit\n' +
					'Error: process completed with exit code 1.',
			}),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('leaves retryAfter undefined when the hint carries no timezone', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your usage limit · resets 1:40pm\n" }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm');
		expect(failure.retryAfter).toBeUndefined();
	});

	it('leaves retryAfter undefined for an unparseable timezone', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Not/AZone)\n" }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.retryAfter).toBeUndefined();
	});

	it('does not misread ordinary output that merely mentions rate limiting', () => {
		// A failed run whose output discusses the concept, without the CLI's own
		// banner or a "resets …" line, must stay a plain error.
		const failure = classifyAgentFailure(
			result({ stdout: 'The code should add a rate limit to the API endpoint.\n' }),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('treats a timed-out run as a timeout regardless of its output', () => {
		const failure = classifyAgentFailure(
			result({ exitCode: null, timedOut: true, stdout: "you've hit your session limit" }),
			NOW,
		);
		expect(failure.kind).toBe('timeout');
	});

	it('classifies an ordinary non-zero exit as a plain error', () => {
		expect(classifyAgentFailure(result({ stderr: 'TypeError: boom' }), NOW).kind).toBe('error');
	});

	it('treats an aborted run as aborted regardless of its output', () => {
		// A run the harness's `signal` cancelled (e.g. the worker's own shutdown)
		// must not be read as a rate-limit even if leftover buffered text happens
		// to contain limit-like phrasing.
		const failure = classifyAgentFailure(
			result({ aborted: true, stdout: "you've hit your session limit" }),
			NOW,
		);
		expect(failure.kind).toBe('aborted');
	});

	it('prioritizes timeout over aborted when both are somehow set', () => {
		expect(classifyAgentFailure(result({ timedOut: true, aborted: true }), NOW).kind).toBe(
			'timeout',
		);
	});

	it('classifies whole-output stall as stalled', () => {
		const failure = classifyAgentFailure(
			result({ stdout: 'Error: timeout waiting for response\n' }),
			NOW,
		);
		expect(failure.kind).toBe('stalled');
	});

	it('classifies trailing-line stall as stalled', () => {
		const failure = classifyAgentFailure(
			result({
				stdout: ' narration line 1\nnarration line 2\nError: timeout waiting for response\n',
			}),
			NOW,
		);
		expect(failure.kind).toBe('stalled');
	});

	it('does not classify mid-transcript stall occurrence as stalled', () => {
		const failure = classifyAgentFailure(
			result({
				stdout:
					'Error: timeout waiting for response\n' + 'Error: process completed with exit code 1.',
			}),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('prioritizes timeout and aborted over a stall phrase', () => {
		const timedOutFailure = classifyAgentFailure(
			result({ timedOut: true, stdout: 'Error: timeout waiting for response' }),
			NOW,
		);
		expect(timedOutFailure.kind).toBe('timeout');

		const abortedFailure = classifyAgentFailure(
			result({ aborted: true, stdout: 'Error: timeout waiting for response' }),
			NOW,
		);
		expect(abortedFailure.kind).toBe('aborted');
	});
});

describe('agentRunError', () => {
	it('wraps the classification and marks the reason in the message', () => {
		const err = agentRunError(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n" }),
			'Review agent (claude) exited with code 1',
			' for PR #90',
			NOW,
		);
		expect(err).toBeInstanceOf(AgentRunError);
		expect(err.message).toBe('Review agent (claude) exited with code 1 (rate limited) for PR #90');
		expect(err.failure.kind).toBe('rate-limit');
	});

	it('notes a timeout and preserves the plain message for an ordinary error', () => {
		expect(agentRunError(result({ timedOut: true }), 'x exited', ' for y', NOW).message).toBe(
			'x exited (timed out) for y',
		);
		expect(agentRunError(result(), 'x exited', ' for y', NOW).message).toBe('x exited for y');
	});

	it('notes an abort', () => {
		const err = agentRunError(result({ aborted: true }), 'x exited', ' for y', NOW);
		expect(err.message).toBe('x exited (aborted) for y');
		expect(err.failure.kind).toBe('aborted');
	});

	it('notes a stall', () => {
		const err = agentRunError(
			result({ stdout: 'Error: timeout waiting for response' }),
			'x exited',
			' for y',
			NOW,
		);
		expect(err.message).toBe('x exited (stalled) for y');
		expect(err.failure.kind).toBe('stalled');
	});
});
