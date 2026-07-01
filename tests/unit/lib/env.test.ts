import { describe, expect, it, vi } from 'vitest';
import { optionalEnv, requireEnv } from '@/lib/env.js';

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
