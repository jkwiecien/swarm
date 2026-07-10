import { describe, expect, it } from 'vitest';
import {
	RUNS_ACTIVE_REFETCH_MS,
	RUNS_IDLE_REFETCH_MS,
	runsListRefetchInterval,
} from './runs-refresh.js';

describe('runsListRefetchInterval', () => {
	it('polls on the idle baseline when data is undefined', () => {
		expect(runsListRefetchInterval(undefined)).toBe(RUNS_IDLE_REFETCH_MS);
	});

	it('polls on the idle baseline when data is null', () => {
		expect(runsListRefetchInterval(null)).toBe(RUNS_IDLE_REFETCH_MS);
	});

	it('polls on the idle baseline when the page is empty', () => {
		expect(runsListRefetchInterval({ data: [] })).toBe(RUNS_IDLE_REFETCH_MS);
	});

	// Regression for #123: previously this returned `false` and stopped polling
	// entirely, so the next phase's freshly-inserted `running` row never surfaced
	// without a manual browser refresh. It must keep polling on the idle baseline.
	it('keeps polling when every run is in a terminal state', () => {
		const terminal = {
			data: [{ status: 'completed' }, { status: 'failed' }, { status: 'deferred' }],
		};
		expect(runsListRefetchInterval(terminal)).toBe(RUNS_IDLE_REFETCH_MS);
	});

	it('polls on the active cadence when at least one run is running', () => {
		const mixed = { data: [{ status: 'completed' }, { status: 'running' }] };
		expect(runsListRefetchInterval(mixed)).toBe(RUNS_ACTIVE_REFETCH_MS);
	});

	// Guards the "expected update window": the interval can never fall into a
	// no-poll state, so a phase change is always picked up within the idle window.
	it('always returns a positive interval within the idle window', () => {
		const inputs = [
			undefined,
			null,
			{ data: [] },
			{ data: [{ status: 'completed' }] },
			{ data: [{ status: 'running' }] },
		];
		for (const input of inputs) {
			const interval = runsListRefetchInterval(input);
			expect(interval).toBeGreaterThan(0);
			expect(interval).toBeLessThanOrEqual(RUNS_IDLE_REFETCH_MS);
			expect(Number.isFinite(interval)).toBe(true);
		}
	});
});
