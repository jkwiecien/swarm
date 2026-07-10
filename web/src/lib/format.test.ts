import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTimeUntil } from './format.js';

describe('formatTimeUntil', () => {
	afterEach(() => vi.useRealTimers());

	it('formats a future instant in minutes', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));

		expect(formatTimeUntil('2026-07-10T10:06:00.000Z')).toBe('in 6 min');
	});

	it.each([
		'2026-07-10T10:00:30.000Z',
		'2026-07-10T09:59:00.000Z',
	])('formats a near or past instant as shortly (%s)', (instant) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));

		expect(formatTimeUntil(instant)).toBe('shortly');
	});
});
