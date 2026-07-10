import { describe, expect, it } from 'vitest';
import {
	AGENT_MODELS,
	ALL_AGENT_MODELS,
	ANTIGRAVITY_MODELS,
	CLAUDE_MODELS,
	CODEX_MODELS,
} from '@/harness/models.js';

describe('AGENT_MODELS', () => {
	it('keys exactly the three known CLIs', () => {
		expect(Object.keys(AGENT_MODELS).sort()).toEqual(['antigravity', 'claude', 'codex']);
	});

	it('maps each CLI to its own model list', () => {
		expect(AGENT_MODELS.claude).toBe(CLAUDE_MODELS);
		expect(AGENT_MODELS.antigravity).toBe(ANTIGRAVITY_MODELS);
		expect(AGENT_MODELS.codex).toBe(CODEX_MODELS);
	});

	it('has no overlap between any two lists (each model name is unambiguous per-cli)', () => {
		const all = [CLAUDE_MODELS, ANTIGRAVITY_MODELS, CODEX_MODELS] as const;
		for (let i = 0; i < all.length; i++) {
			for (let j = i + 1; j < all.length; j++) {
				const overlap = (all[i] as readonly string[]).filter((m) =>
					(all[j] as readonly string[]).includes(m),
				);
				expect(overlap).toEqual([]);
			}
		}
	});
});

describe('ALL_AGENT_MODELS', () => {
	it('is the union of all per-cli lists', () => {
		expect(ALL_AGENT_MODELS).toEqual([...CLAUDE_MODELS, ...ANTIGRAVITY_MODELS, ...CODEX_MODELS]);
	});
});
