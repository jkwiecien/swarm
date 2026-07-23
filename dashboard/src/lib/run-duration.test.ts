import { describe, expect, it } from 'vitest';
import { resolveRunDurationMs } from './run-duration.js';

const nowMs = Date.parse('2026-07-10T12:00:00.000Z');

function run(overrides: Partial<Parameters<typeof resolveRunDurationMs>[0]> = {}) {
	return {
		status: 'running',
		startedAt: '2026-07-10T11:58:30.000Z',
		completedAt: null,
		durationMs: null,
		...overrides,
	};
}

describe('resolveRunDurationMs', () => {
	it('returns elapsed time for a running run', () => {
		expect(resolveRunDurationMs(run(), nowMs)).toBe(90_000);
	});

	it('advances a running duration as the current time advances', () => {
		expect(resolveRunDurationMs(run(), nowMs + 10_000)).toBe(100_000);
	});

	it.each([
		null,
		'',
		'not-a-timestamp',
	])('handles a missing or invalid start timestamp: %s', (startedAt) => {
		expect(resolveRunDurationMs(run({ startedAt }), nowMs)).toBeNull();
	});

	it('clamps a running duration to zero when the start is in the future', () => {
		expect(resolveRunDurationMs(run({ startedAt: '2026-07-10T12:00:01.000Z' }), nowMs)).toBe(0);
	});

	it('keeps the stored duration for a completed run', () => {
		expect(
			resolveRunDurationMs(run({ status: 'completed', durationMs: 42_000 }), nowMs + 60_000),
		).toBe(42_000);
	});

	it('calculates a terminal duration from start and completion timestamps when needed', () => {
		expect(
			resolveRunDurationMs(
				run({ status: 'completed', completedAt: '2026-07-10T12:00:00.000Z' }),
				nowMs + 60_000,
			),
		).toBe(90_000);
	});

	it.each([
		'completed',
		'failed',
		'deferred',
	])('returns null for a %s run without a stored duration or completion timestamp', (status) => {
		expect(resolveRunDurationMs(run({ status }), nowMs)).toBeNull();
	});

	it.each(['failed', 'deferred'])('calculates the final duration for a %s run', (status) => {
		expect(
			resolveRunDurationMs(
				run({ status, completedAt: '2026-07-10T12:00:00.000Z' }),
				nowMs + 60_000,
			),
		).toBe(90_000);
	});

	it('clamps a calculated terminal duration to zero', () => {
		expect(
			resolveRunDurationMs(
				run({ status: 'completed', completedAt: '2026-07-10T11:00:00.000Z' }),
				nowMs,
			),
		).toBe(0);
	});
});
