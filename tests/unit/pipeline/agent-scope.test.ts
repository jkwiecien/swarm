import { describe, expect, it } from 'vitest';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';

describe('pipelinePhaseGuard', () => {
	it('rejects every subagent', () => {
		const prompt = pipelinePhaseGuard().join('\n');
		expect(prompt).toContain('Do NOT spawn subagents');
		expect(prompt).toContain('Do NOT perform work belonging to another pipeline phase');
	});
});
