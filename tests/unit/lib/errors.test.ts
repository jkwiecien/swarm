import { describe, expect, it } from 'vitest';
import { describeError } from '@/lib/errors.js';

describe('describeError', () => {
	it('returns the message of a plain error', () => {
		expect(describeError(new Error('boom'))).toBe('boom');
	});

	it('appends the cause chain so the real reason is visible', () => {
		// Mirrors Drizzle: an opaque wrapper message with the useful pg error in
		// `.cause` (the exact case that made the runs-insert failure undiagnosable).
		const pgError = new Error('column "usage" does not exist');
		const wrapper = new Error('Failed query: insert into "runs" …', { cause: pgError });
		expect(describeError(wrapper)).toBe(
			'Failed query: insert into "runs" … ← column "usage" does not exist',
		);
	});

	it('walks multiple nested causes', () => {
		const root = new Error('ECONNRESET');
		const mid = new Error('connection terminated', { cause: root });
		const top = new Error('Failed query', { cause: mid });
		expect(describeError(top)).toBe('Failed query ← connection terminated ← ECONNRESET');
	});

	it('stops on a cyclic cause chain instead of looping forever', () => {
		const a = new Error('a');
		const b = new Error('b', { cause: a });
		a.cause = b;
		expect(describeError(a)).toBe('a ← b');
	});

	it('ignores a non-Error cause', () => {
		const err = new Error('top', { cause: 'just a string' });
		expect(describeError(err)).toBe('top');
	});

	it('stringifies a non-Error value', () => {
		expect(describeError('plain string')).toBe('plain string');
		expect(describeError(42)).toBe('42');
	});
});
