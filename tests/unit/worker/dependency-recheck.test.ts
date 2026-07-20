import { describe, expect, it } from 'vitest';

import {
	DEFAULT_DEPENDENCY_MAX_WAIT_MS,
	DEFAULT_DEPENDENCY_RECHECK_INTERVAL_MS,
	maxDependencyRechecks,
	resolveDependencyMaxWaitMs,
	resolveDependencyRecheckIntervalMs,
} from '@/worker/dependency-recheck.js';

describe('resolveDependencyRecheckIntervalMs', () => {
	it('defaults when unset', () => {
		expect(resolveDependencyRecheckIntervalMs(undefined)).toBe(
			DEFAULT_DEPENDENCY_RECHECK_INTERVAL_MS,
		);
		expect(resolveDependencyRecheckIntervalMs('')).toBe(DEFAULT_DEPENDENCY_RECHECK_INTERVAL_MS);
	});

	it('parses a positive integer override', () => {
		expect(resolveDependencyRecheckIntervalMs('60000')).toBe(60000);
	});

	it('throws on a non-positive or non-integer value', () => {
		expect(() => resolveDependencyRecheckIntervalMs('0')).toThrow(/positive integer/);
		expect(() => resolveDependencyRecheckIntervalMs('-1')).toThrow(/positive integer/);
		expect(() => resolveDependencyRecheckIntervalMs('abc')).toThrow(/positive integer/);
	});
});

describe('resolveDependencyMaxWaitMs', () => {
	it('defaults when unset', () => {
		expect(resolveDependencyMaxWaitMs(undefined)).toBe(DEFAULT_DEPENDENCY_MAX_WAIT_MS);
	});

	it('parses an override', () => {
		expect(resolveDependencyMaxWaitMs('3600000')).toBe(3600000);
	});
});

describe('maxDependencyRechecks', () => {
	it('is the number of intervals that fit in the wait budget', () => {
		expect(maxDependencyRechecks(5 * 60 * 1000, 60 * 60 * 1000)).toBe(12);
	});

	it('is at least 1 even for a tiny budget', () => {
		expect(maxDependencyRechecks(10_000, 1)).toBe(1);
	});

	it('derives ~7 days of 5-minute checks from the defaults', () => {
		expect(
			maxDependencyRechecks(DEFAULT_DEPENDENCY_RECHECK_INTERVAL_MS, DEFAULT_DEPENDENCY_MAX_WAIT_MS),
		).toBe(2016);
	});
});
