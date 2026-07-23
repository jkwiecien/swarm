import { describe, expect, it } from 'vitest';
import { canRetryRun, retryActionKind, retryButtonLabel } from './run-retry.js';

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

describe('retryActionKind', () => {
	it('resumes a deferred run that kept a captured agent session', () => {
		expect(retryActionKind('deferred', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('resume');
	});

	it('is a fresh retry for a deferred run with no captured session', () => {
		expect(retryActionKind('deferred', null)).toBe('retry');
	});

	it('is a fresh retry for a failed run even if a session id lingers', () => {
		expect(retryActionKind('failed', null)).toBe('retry');
		expect(retryActionKind('failed', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('retry');
	});

	it('never resumes a non-retryable status that still holds a session', () => {
		expect(retryActionKind('running', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('retry');
		expect(retryActionKind('completed', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('retry');
	});
});

describe('retryButtonLabel', () => {
	it('labels a resume action', () => {
		expect(retryButtonLabel('resume', false)).toBe('Resume');
		expect(retryButtonLabel('resume', true)).toBe('Resuming…');
	});

	it('labels a fresh retry action', () => {
		expect(retryButtonLabel('retry', false)).toBe('Retry now');
		expect(retryButtonLabel('retry', true)).toBe('Retrying…');
	});
});
