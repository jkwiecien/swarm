import { describe, expect, it } from 'vitest';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';

describe('pipelinePhaseGuard', () => {
	it('rejects every subagent when curated delegation is disabled', () => {
		const prompt = pipelinePhaseGuard(false).join('\n');
		expect(prompt).toContain('Do NOT spawn subagents');
		expect(prompt).toContain('No curated delegation is enabled');
	});

	it('permits only the SWARM-orchestrated child command when delegation is enabled', () => {
		const prompt = pipelinePhaseGuard(true).join('\n');
		expect(prompt).toContain('Do NOT spawn CLI subagents');
		expect(prompt).toContain('$SWARM_DELEGATE_COMMAND');
		expect(prompt).toContain('.swarm-delegation-review.json');
		expect(prompt).toContain('commit/push/PR/review/comment/board mutation');
		expect(prompt).toContain('Do NOT perform work belonging to another pipeline phase');
	});
});
