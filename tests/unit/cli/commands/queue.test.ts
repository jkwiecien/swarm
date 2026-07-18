import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelAllWaitingWork, closeQueue, closeDb } = vi.hoisted(() => ({
	cancelAllWaitingWork:
		vi.fn<(reason: string) => Promise<{ cancelledDispatches: number; removedJobs: number }>>(),
	closeQueue: vi.fn<() => Promise<void>>(),
	closeDb: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/dispatch/dispatcher.js', () => ({ cancelAllWaitingWork }));
vi.mock('@/queue/producer.js', () => ({ closeQueue }));
vi.mock('@/db/client.js', () => ({ closeDb }));

import { run } from '@/cli/commands/queue.js';

describe('queue command', () => {
	beforeEach(() => {
		cancelAllWaitingWork.mockReset().mockResolvedValue({
			cancelledDispatches: 2,
			removedJobs: 3,
		});
		closeQueue.mockReset().mockResolvedValue(undefined);
		closeDb.mockReset().mockResolvedValue(undefined);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('cancels waiting dispatches canonically and closes the connections', async () => {
		await expect(run(['clear'])).resolves.toBe(0);
		expect(cancelAllWaitingWork).toHaveBeenCalledExactlyOnceWith(
			'Cancelled by `swarm queue clear`',
		);
		expect(closeQueue).toHaveBeenCalledOnce();
		expect(closeDb).toHaveBeenCalledOnce();
	});

	it('rejects an unknown subcommand without opening connections', async () => {
		await expect(run(['remove'])).resolves.toBe(1);
		expect(cancelAllWaitingWork).not.toHaveBeenCalled();
		expect(closeQueue).not.toHaveBeenCalled();
	});
});
