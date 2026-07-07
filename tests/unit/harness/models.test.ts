import { describe, expect, it } from 'vitest';
import {
	AGENT_MODELS,
	ALL_AGENT_MODELS,
	ANTIGRAVITY_MODELS,
	CLAUDE_MODELS,
} from '@/harness/models.js';

describe('AGENT_MODELS', () => {
	it('keys exactly the two known CLIs', () => {
		expect(Object.keys(AGENT_MODELS).sort()).toEqual(['antigravity', 'claude']);
	});

	it('maps claude to its short aliases and antigravity to its exact agy model names', () => {
		expect(AGENT_MODELS.claude).toBe(CLAUDE_MODELS);
		expect(AGENT_MODELS.antigravity).toBe(ANTIGRAVITY_MODELS);
	});

	it('has no overlap between the two lists (each model name is unambiguous per-cli)', () => {
		const overlap = CLAUDE_MODELS.filter((m) =>
			(ANTIGRAVITY_MODELS as readonly string[]).includes(m),
		);
		expect(overlap).toEqual([]);
	});
});

describe('ALL_AGENT_MODELS', () => {
	it('is the union of both per-cli lists', () => {
		expect(ALL_AGENT_MODELS).toEqual([...CLAUDE_MODELS, ...ANTIGRAVITY_MODELS]);
	});
});
