import { describe, expect, it } from 'vitest';
import { canRetryRun, retryButtonLabel } from './run-retry.js';

describe('canRetryRun', () => {
	it('allows retry for a deferred or failed run', () => {
		expect(canRetryRun('deferred')).toBe(true);
		expect(canRetryRun('failed')).toBe(true);
	});

	it('disallows retry for running and completed runs', () => {
		expect(canRetryRun('running')).toBe(false);
		expect(canRetryRun('completed')).toBe(false);
	});

	it('disallows retry for an unknown status', () => {
		expect(canRetryRun('whatever')).toBe(false);
	});
});

describe('retryButtonLabel', () => {
	it('reads "Retrying…" while the mutation is pending', () => {
		expect(retryButtonLabel(true)).toBe('Retrying…');
	});

	it('reads "Retry now" when idle', () => {
		expect(retryButtonLabel(false)).toBe('Retry now');
	});
});
