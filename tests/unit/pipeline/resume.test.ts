import { describe, expect, it } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import { shouldPreserveForResume } from '@/pipeline/resume.js';

function mockAgentResult(sessionId?: string): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 1,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 100,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		sessionId,
	};
}

describe('shouldPreserveForResume', () => {
	it('preserves the worktree for a stalled result with a session id', () => {
		const error = new AgentRunError(
			'stalled error',
			{ kind: 'stalled' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(true);
	});

	it('does not preserve the worktree for a stalled result without a session id', () => {
		const error = new AgentRunError(
			'stalled error',
			{ kind: 'stalled' },
			mockAgentResult(undefined),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});

	it('preserves the worktree for a rate-limit result with a session id', () => {
		const error = new AgentRunError(
			'rate-limit error',
			{ kind: 'rate-limit' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(true);
	});

	it('does not preserve the worktree for a rate-limit result without a session id', () => {
		const error = new AgentRunError(
			'rate-limit error',
			{ kind: 'rate-limit' },
			mockAgentResult(undefined),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});

	it('preserves the worktree for a timeout result with a session id', () => {
		const error = new AgentRunError(
			'timeout error',
			{ kind: 'timeout' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(true);
	});

	it('does not preserve the worktree for a timeout result without a session id', () => {
		const error = new AgentRunError(
			'timeout error',
			{ kind: 'timeout' },
			mockAgentResult(undefined),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});

	it('does not preserve the worktree for generic errors even with a session id', () => {
		const error = new AgentRunError(
			'generic error',
			{ kind: 'error' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});
});
