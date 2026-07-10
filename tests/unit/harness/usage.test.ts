import { describe, expect, it } from 'vitest';
import { parseAgentOutput } from '@/harness/usage.js';

describe('parseAgentOutput', () => {
	describe('claude', () => {
		it('normalizes a full usage block and extracts the readable result text', () => {
			const stdout = JSON.stringify({
				result: 'Here is the final answer.',
				usage: {
					input_tokens: 1234,
					output_tokens: 567,
					cache_read_input_tokens: 89,
					cache_creation_input_tokens: 10,
				},
			});

			expect(parseAgentOutput('claude', stdout)).toEqual({
				usage: {
					inputTokens: 1234,
					outputTokens: 567,
					cacheReadTokens: 89,
					cacheCreationTokens: 10,
				},
				logText: 'Here is the final answer.',
			});
		});

		it('validates with only input/output tokens, leaving optional fields absent', () => {
			const stdout = JSON.stringify({
				result: 'done',
				usage: { input_tokens: 10, output_tokens: 5 },
			});

			expect(parseAgentOutput('claude', stdout)).toEqual({
				usage: { inputTokens: 10, outputTokens: 5 },
				logText: 'done',
			});
		});

		it('returns {} for malformed JSON', () => {
			expect(parseAgentOutput('claude', 'not json at all')).toEqual({});
		});

		it('returns {} for a response missing the usage field', () => {
			const stdout = JSON.stringify({ result: 'done, no usage reported' });
			expect(parseAgentOutput('claude', stdout)).toEqual({});
		});

		it('returns {} for a truncated JSON string', () => {
			const truncated = JSON.stringify({
				result: 'partial',
				usage: { input_tokens: 1, output_tokens: 2 },
			}).slice(0, 20);

			expect(parseAgentOutput('claude', truncated)).toEqual({});
		});
	});

	describe('antigravity / codex', () => {
		it('returns {} — usage extraction is not yet implemented for these CLIs', () => {
			const stdout = JSON.stringify({
				result: 'done',
				usage: { input_tokens: 1, output_tokens: 2 },
			});

			expect(parseAgentOutput('antigravity', stdout)).toEqual({});
			expect(parseAgentOutput('codex', stdout)).toEqual({});
		});
	});
});
