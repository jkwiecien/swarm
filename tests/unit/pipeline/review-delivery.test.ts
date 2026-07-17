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
		const markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 }));
		const abandonReviewVerdict = vi.fn(async () => undefined);
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
			markReviewVerdictSubmitted,
			abandonReviewVerdict,
		};

		await expect(runReviewPhase(options)).rejects.toBeInstanceOf(DeliveryDeferredError);
		expect(cleanup).not.toHaveBeenCalled();
		expect(runAgent).toHaveBeenCalledTimes(1);
		// The failure happened after delivery progress existed (an ambiguous
		// mid-submission failure), so the reservation is preserved, not abandoned
		// (issue #235).
		expect(abandonReviewVerdict).not.toHaveBeenCalled();

		await expect(runReviewPhase({ ...options, resumeDelivery: true })).resolves.toMatchObject({
			verdict: 'approve',
			reviewOrdinal: 1,
		});
		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(worktrees.reuse).toHaveBeenCalledWith('review-42', 'abc', true, expect.any(Function));
		expect(worktrees.provision).toHaveBeenCalledTimes(1);
		expect(submitReview).toHaveBeenCalledTimes(2);
		expect(cleanup).toHaveBeenCalledTimes(1);
		// Marked submitted exactly once, on the successful (resumed) attempt, with
		// the recovered review id.
		expect(markReviewVerdictSubmitted).toHaveBeenCalledTimes(1);
		expect(markReviewVerdictSubmitted).toHaveBeenCalledWith(
			{
				projectId: options.project.id,
				repository: options.project.repo,
				prNumber: '42',
				headSha: 'abc',
			},
			{ verdict: 'approve', reviewId: '77' },
		);
	});
});
