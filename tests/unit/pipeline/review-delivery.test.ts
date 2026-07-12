import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { runReviewPhase } from '@/pipeline/review.js';
import { DeliveryDeferredError, type ScmDeliveryProvider } from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentResult(): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		sessionId: 'session-1',
	};
}

describe('review production delivery', () => {
	it('preserves progress after a step failure and resumes before the agent without duplicating delivery', async () => {
		const path = mkdtempSync(join(tmpdir(), 'swarm-review-delivery-'));
		roots.push(path);
		const handle: WorktreeHandle = { taskId: 'review-42', path, branch: 'abc', detached: true };
		const cleanup = vi.fn(async () => undefined);
		const worktrees = {
			provision: vi.fn(async () => handle),
			reuse: vi.fn(async () => handle),
			cleanup,
		} as unknown as GitWorktreeManager;
		const runAgent = vi.fn(async () => {
			writeFileSync(
				join(path, 'review_handoff.json'),
				JSON.stringify({
					verdict: 'approve',
					body: 'Looks good',
					findings: [],
				}),
			);
			return agentResult();
		});
		const submitReview = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValue(77);
		const delivery = {
			commitIdentity: { name: 'reviewer', email: 'reviewer@users.noreply.github.com' },
			findPullRequest: vi.fn(),
			createPullRequest: vi.fn(),
			pushBranch: vi.fn(),
			submitReview,
			postComment: vi.fn(),
		} as unknown as ScmDeliveryProvider;
		const options = {
			project: createMockProjectConfig(),
			prNumber: '42',
			headSha: 'abc',
			taskId: 'review-42',
			worktrees,
			runAgent,
			graft: vi.fn(() => []),
			getToken: vi.fn(async () => 'review-token'),
			delivery,
		};

		await expect(runReviewPhase(options)).rejects.toBeInstanceOf(DeliveryDeferredError);
		expect(cleanup).not.toHaveBeenCalled();
		expect(runAgent).toHaveBeenCalledTimes(1);

		await expect(
			runReviewPhase({ ...options, resumeSessionId: 'session-1' }),
		).resolves.toMatchObject({
			verdict: 'approve',
		});
		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(submitReview).toHaveBeenCalledTimes(2);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
