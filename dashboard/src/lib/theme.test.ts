// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSystemTheme, resolveTheme, subscribeToSystemTheme } from './theme.js';

function stubMatchMedia(matches: boolean) {
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const mql = {
		matches,
		media: '(prefers-color-scheme: dark)',
		addEventListener: vi.fn((_: 'change', listener: (event: MediaQueryListEvent) => void) => {
			listeners.add(listener);
		}),
		removeEventListener: vi.fn((_: 'change', listener: (event: MediaQueryListEvent) => void) => {
			listeners.delete(listener);
		}),
	};
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => mql),
	);
	return {
		mql,
		fire: (next: boolean) => {
			mql.matches = next;
			for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
		},
	};
}

describe('getSystemTheme', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns dark when the OS prefers dark', () => {
		stubMatchMedia(true);
		expect(getSystemTheme()).toBe('dark');
	});

	it('returns light when the OS prefers light', () => {
		stubMatchMedia(false);
		expect(getSystemTheme()).toBe('light');
	});

	it('falls back to dark when matchMedia is unavailable', () => {
		vi.stubGlobal('matchMedia', undefined);
		expect(getSystemTheme()).toBe('dark');
	});
});

describe('resolveTheme', () => {
	it('passes dark and light through unchanged', () => {
		expect(resolveTheme('dark', 'light')).toBe('dark');
		expect(resolveTheme('light', 'dark')).toBe('light');
	});

	it('resolves system to the live system theme', () => {
		expect(resolveTheme('system', 'dark')).toBe('dark');
		expect(resolveTheme('system', 'light')).toBe('light');
	});
});

describe('subscribeToSystemTheme', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('invokes the callback with the new resolved theme on a live preference change', () => {
		const { fire } = stubMatchMedia(true);
		const onChange = vi.fn();
		subscribeToSystemTheme(onChange);

		fire(false);
		expect(onChange).toHaveBeenCalledWith('light');

		fire(true);
		expect(onChange).toHaveBeenCalledWith('dark');
	});

	it('stops invoking the callback after unsubscribing', () => {
		const { fire, mql } = stubMatchMedia(true);
		const onChange = vi.fn();
		const unsubscribe = subscribeToSystemTheme(onChange);

		unsubscribe();
		fire(false);

		expect(onChange).not.toHaveBeenCalled();
		expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
	});

	it('returns a no-op unsubscribe when matchMedia is unavailable', () => {
		vi.stubGlobal('matchMedia', undefined);
		const unsubscribe = subscribeToSystemTheme(vi.fn());
		expect(() => unsubscribe()).not.toThrow();
	});
});
