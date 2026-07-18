import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clearPendingJobs, closeQueue } = vi.hoisted(() => ({
	clearPendingJobs: vi.fn<() => Promise<number>>(),
	closeQueue: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/queue/producer.js', () => ({ clearPendingJobs, closeQueue }));

import { run } from '@/cli/commands/queue.js';

describe('queue command', () => {
	beforeEach(() => {
		clearPendingJobs.mockReset().mockResolvedValue(2);
		closeQueue.mockReset().mockResolvedValue(undefined);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('clears pending jobs and closes the Redis connection', async () => {
		await expect(run(['clear'])).resolves.toBe(0);
		expect(clearPendingJobs).toHaveBeenCalledOnce();
		expect(closeQueue).toHaveBeenCalledOnce();
	});

	it('rejects an unknown subcommand without opening Redis', async () => {
		await expect(run(['remove'])).resolves.toBe(1);
		expect(clearPendingJobs).not.toHaveBeenCalled();
		expect(closeQueue).not.toHaveBeenCalled();
	});
});
