import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_JOB_AGE_MS, isJobStale, resolveMaxJobAgeMs } from '@/worker/job-freshness.js';

describe('job freshness', () => {
	it('defaults to one day when unset', () => {
		expect(resolveMaxJobAgeMs(undefined)).toBe(DEFAULT_MAX_JOB_AGE_MS);
	});

	it('accepts a positive integer override and rejects invalid values', () => {
		expect(resolveMaxJobAgeMs('123')).toBe(123);
		expect(() => resolveMaxJobAgeMs('0')).toThrow('SWARM_MAX_JOB_AGE_MS');
		expect(() => resolveMaxJobAgeMs('1.5')).toThrow('SWARM_MAX_JOB_AGE_MS');
	});

	it('treats only jobs older than the configured maximum as stale', () => {
		expect(isJobStale(1_000, 500, 1_500)).toBe(false);
		expect(isJobStale(1_000, 500, 1_501)).toBe(true);
	});
});
