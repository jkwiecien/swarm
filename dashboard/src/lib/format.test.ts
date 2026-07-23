import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTimeUntil, formatTokenCount, formatTokensCompact } from './format.js';

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

describe('formatTokenCount', () => {
	it('renders sub-1000 counts as plain integers', () => {
		expect(formatTokenCount(0)).toBe('0');
		expect(formatTokenCount(999)).toBe('999');
	});

	it('renders thousands with one decimal, trimming a trailing zero', () => {
		expect(formatTokenCount(1234)).toBe('1.2k');
		expect(formatTokenCount(2000)).toBe('2k');
	});

	it('renders millions with up to two decimals, trimming trailing zeros', () => {
		expect(formatTokenCount(1_050_000)).toBe('1.05M');
		expect(formatTokenCount(1_000_000)).toBe('1M');
		expect(formatTokenCount(1_200_000)).toBe('1.2M');
	});
});

describe('formatTokensCompact', () => {
	it('renders input / output as compact counts', () => {
		expect(formatTokensCompact({ inputTokens: 12345, outputTokens: 4100 })).toBe('12.3k / 4.1k');
	});

	it('renders — when usage was not reported', () => {
		expect(formatTokensCompact(null)).toBe('—');
	});
});
