import { describe, expect, it, vi } from 'vitest';
import { isSingleUserMode, optionalEnv, requireEnv } from '@/lib/env.js';

describe('requireEnv', () => {
	it('returns the value when the variable is set', () => {
		vi.stubEnv('SWARM_TEST_VAR', 'hello');
		expect(requireEnv('SWARM_TEST_VAR')).toBe('hello');
	});

	it('throws when the variable is unset', () => {
		vi.stubEnv('SWARM_TEST_VAR', '');
		expect(() => requireEnv('SWARM_TEST_VAR')).toThrow(/Missing required environment variable/);
	});
});

describe('optionalEnv', () => {
	it('returns the value when set', () => {
		vi.stubEnv('SWARM_TEST_VAR', 'set');
		expect(optionalEnv('SWARM_TEST_VAR', 'fallback')).toBe('set');
	});

	it('returns the fallback when unset', () => {
		vi.stubEnv('SWARM_TEST_VAR', '');
		expect(optionalEnv('SWARM_TEST_VAR', 'fallback')).toBe('fallback');
	});
});

describe('isSingleUserMode', () => {
	it('is enabled only for the literal "true"', () => {
		vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');
		expect(isSingleUserMode()).toBe(true);
	});

	it('is disabled when unset (the coded default keeps multi-user auth)', () => {
		vi.stubEnv('SWARM_SINGLE_USER_MODE', '');
		expect(isSingleUserMode()).toBe(false);
	});

	it('is disabled for any other value', () => {
		for (const value of ['false', '1', 'yes', 'TRUE', 'on']) {
			vi.stubEnv('SWARM_SINGLE_USER_MODE', value);
			expect(isSingleUserMode()).toBe(false);
		}
	});
});
