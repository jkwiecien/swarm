import { describe, expect, it } from 'vitest';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';

describe('pipelinePhaseGuard', () => {
	it('rejects every subagent when native delegation is disabled', () => {
		const prompt = pipelinePhaseGuard(false).join('\n');
		expect(prompt).toContain('Do NOT spawn subagents');
		expect(prompt).toContain('No native delegation is enabled');
	});

	it('permits only the curated contract while retaining deterministic delivery boundaries', () => {
		const prompt = pipelinePhaseGuard(true).join('\n');
		expect(prompt).toContain('only the curated `swarm-doc-editor` native subagent');
		expect(prompt).toContain('<swarm-delegation-contract>');
		expect(prompt).toContain('Never delegate commit, push, PR/review/comment/board mutation');
		expect(prompt).toContain('.swarm-delegation-review.json');
		expect(prompt).toContain('Do NOT perform work belonging to another pipeline phase');
	});
});
