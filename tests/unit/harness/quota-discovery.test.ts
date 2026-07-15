import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock DB/runsRepository
vi.mock('@/db/client.js', () => ({
	getDb: vi.fn().mockReturnValue({
		select: vi.fn().mockReturnThis(),
		from: vi.fn().mockReturnThis(),
		where: vi.fn().mockReturnThis(),
		orderBy: vi.fn().mockReturnThis(),
		limit: vi.fn().mockResolvedValue([]),
	}),
}));

// Mock child_process
const mockSpawn = vi.fn();
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
	spawn: (...args: any[]) => mockSpawn(...args),
	execFile: (...args: any[]) => mockExecFile(...args),
}));

import { isBinaryRunnable, queryCodexQuota } from '@/harness/quota-discovery.js';

describe('quota-discovery', () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockExecFile.mockReset();
	});

	describe('isBinaryRunnable', () => {
		it('returns true if execFile runs successfully', async () => {
			mockExecFile.mockImplementation((...args: any[]) => {
				const cb = args[args.length - 1];
				cb(null, { stdout: 'version 1.0' }, '');
			});
			const result = await isBinaryRunnable('claude');
			expect(result).toBe(true);
		});

		it('returns false if execFile fails with ENOENT', async () => {
			mockExecFile.mockImplementation((...args: any[]) => {
				const cb = args[args.length - 1];
				cb({ code: 'ENOENT' }, null, null);
			});
			const result = await isBinaryRunnable('missing-cli');
			expect(result).toBe(false);
		});
	});

	describe('queryCodexQuota', () => {
		it('negotiates JSON-RPC initialize and rateLimits read successfully', async () => {
			const mockStdin = {
				write: vi.fn(),
			};
			const mockStdout = new EventEmitter();
			const mockChild = Object.assign(new EventEmitter(), {
				stdin: mockStdin,
				stdout: mockStdout,
				kill: vi.fn(),
			});

			mockSpawn.mockReturnValue(mockChild);

			const promise = queryCodexQuota();

			// Simulate initialize response from app-server
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						result: {
							userAgent: 'test',
							codexHome: '/home',
							platformFamily: 'unix',
							platformOs: 'macos',
						},
					}) + '\n',
				),
			);

			// Expect initialize sent
			expect(mockStdin.write).toHaveBeenCalledWith(
				expect.stringContaining('"method":"initialize"'),
			);

			// Simulate rateLimits/read response
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 2,
						result: {
							rateLimits: {
								limitId: 'codex',
								planType: 'plus',
								primary: {
									usedPercent: 45,
									windowDurationMins: 300,
									resetsAt: 1700000000,
								},
								credits: {
									balance: '12',
								},
							},
							rateLimitResetCredits: {
								availableCount: 2,
							},
						},
					}) + '\n',
				),
			);

			const result = await promise;
			expect(result.status).toBe('available');
			expect(result.remainingPercentage).toBe(55);
			expect(result.plan).toBe('plus');
			expect(result.credits).toBe('balance: 12, resets: 2');
			expect(result.windows).toHaveLength(1);
			expect(result.windows?.[0]).toEqual({
				name: 'Primary (5-hour)',
				durationMins: 300,
				usedPercent: 45,
				resetsAt: new Date(1700000000 * 1000).toISOString(),
			});
		});

		it('returns error if app-server fails during initialize', async () => {
			const mockStdin = { write: vi.fn() };
			const mockStdout = new EventEmitter();
			const mockChild = Object.assign(new EventEmitter(), {
				stdin: mockStdin,
				stdout: mockStdout,
				kill: vi.fn(),
			});

			mockSpawn.mockReturnValue(mockChild);

			const promise = queryCodexQuota();

			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						error: { code: -32600, message: 'Invalid request' },
					}) + '\n',
				),
			);

			const result = await promise;
			expect(result.status).toBe('error');
			expect(result.error).toContain('Initialize error');
		});
	});
});
