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

		it('captures session_id from the JSON output as sessionId', () => {
			const stdout = JSON.stringify({
				result: 'done',
				session_id: '11111111-2222-3333-4444-555555555555',
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			expect(parseAgentOutput('claude', stdout).sessionId).toBe(
				'11111111-2222-3333-4444-555555555555',
			);
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

	describe('codex', () => {
		it('normalizes the captured JSONL usage event and extracts readable text', () => {
			const stdout = [
				'{"type":"thread.started","thread_id":"019f4f7e-..."}',
				'{"type":"turn.started"}',
				'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
				'{"type":"turn.completed","usage":{"input_tokens":12201,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
			].join('\n');

			expect(parseAgentOutput('codex', stdout)).toEqual({
				usage: {
					inputTokens: 12201,
					outputTokens: 5,
					cacheReadTokens: 9984,
					reasoningTokens: 0,
				},
				logText: 'pong',
				sessionId: '019f4f7e-...',
			});
		});

		it('captures the thread id from the thread.started event as sessionId', () => {
			const stdout = [
				'{"type":"thread.started","thread_id":"019f57a7-cf1b-72d3-b887-63758a10f3a8"}',
				'{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}',
			].join('\n');
			expect(parseAgentOutput('codex', stdout).sessionId).toBe(
				'019f57a7-cf1b-72d3-b887-63758a10f3a8',
			);
		});

		it('accepts input/output-only usage', () => {
			const stdout = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}';
			expect(parseAgentOutput('codex', stdout)).toEqual({
				usage: { inputTokens: 10, outputTokens: 5 },
			});
		});

		it('keeps readable text when usage is missing', () => {
			const stdout = '{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}';
			expect(parseAgentOutput('codex', stdout)).toEqual({ logText: 'pong' });
		});

		it('skips malformed and truncated JSONL without throwing', () => {
			expect(parseAgentOutput('codex', 'not json\n{"type":"turn.completed"')).toEqual({});
		});

		it('uses the last valid turn usage and joins agent messages', () => {
			const stdout = [
				'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
				'{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
				'{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
				'{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
			].join('\n');

			expect(parseAgentOutput('codex', stdout)).toEqual({
				usage: { inputTokens: 3, outputTokens: 4 },
				logText: 'first\nsecond',
			});
		});
	});

	describe('antigravity', () => {
		it('returns {} because agy cannot emit structured usage', () => {
			const stdout = JSON.stringify({
				result: 'done',
				usage: { input_tokens: 1, output_tokens: 2 },
			});

			expect(parseAgentOutput('antigravity', stdout)).toEqual({});
		});
	});
});
