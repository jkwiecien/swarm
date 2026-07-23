import type { AppearanceTheme } from '../../../src/config/app-settings.js';

/** Re-exported for callers that only care about the dashboard's theme choice. */
export type { AppearanceTheme } from '../../../src/config/app-settings.js';

/** The two themes the dashboard actually renders — `system` always resolves to one of these. */
export type ResolvedTheme = 'dark' | 'light';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * The OS/browser's current color-scheme preference. Falls back to `dark` —
 * the dashboard's original look — when `matchMedia` isn't available (e.g. an
 * older browser or a non-DOM test environment), rather than guessing light.
 */
export function getSystemTheme(): ResolvedTheme {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
	return window.matchMedia(DARK_MEDIA_QUERY).matches ? 'dark' : 'light';
}

/**
 * Resolve a saved preference to the theme that should actually render:
 * `system` follows the live OS/browser preference, `dark`/`light` are already
 * a {@link ResolvedTheme} and pass through unchanged.
 */
export function resolveTheme(
	preference: AppearanceTheme,
	systemTheme: ResolvedTheme,
): ResolvedTheme {
	return preference === 'system' ? systemTheme : preference;
}

/**
 * Subscribe to live OS/browser color-scheme changes, invoking `onChange` with
 * the new {@link ResolvedTheme} whenever the preference flips. Returns an
 * unsubscribe function; a no-op unsubscribe when `matchMedia` is unavailable
 * so callers don't need an environment check of their own.
 */
export function subscribeToSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
	const query = window.matchMedia(DARK_MEDIA_QUERY);
	const listener = (event: MediaQueryListEvent) => onChange(event.matches ? 'dark' : 'light');
	query.addEventListener('change', listener);
	return () => query.removeEventListener('change', listener);
}
