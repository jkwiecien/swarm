import { describe, expect, it } from 'vitest';
import { normalizeRunError, RUN_CANCELLED_MESSAGE } from './run-cancellation.js';

describe('normalizeRunError', () => {
	it('rewrites the exact legacy user-termination string to the neutral wording', () => {
		expect(normalizeRunError('Run terminated by user from the dashboard.')).toBe(
			RUN_CANCELLED_MESSAGE,
		);
	});

	it('passes an arbitrary error through untouched', () => {
		expect(normalizeRunError('Agent crashed with exit code 1')).toBe(
			'Agent crashed with exit code 1',
		);
	});

	it('does not rewrite a message that only partially matches the legacy string', () => {
		const message = 'Run terminated by user from the dashboard, then retried.';
		expect(normalizeRunError(message)).toBe(message);
	});
});
