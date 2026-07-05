import { describe, expect, it } from 'vitest';
import { runCommand } from '@/cli/_shared/exec.js';

describe('runCommand', () => {
	it('resolves with the child process exit code', async () => {
		await expect(runCommand('node', ['-e', 'process.exit(3)'])).resolves.toBe(3);
	});

	it('resolves 0 when the child exits cleanly', async () => {
		await expect(runCommand('node', ['-e', ''])).resolves.toBe(0);
	});

	it('rejects with a PATH hint when the binary is missing', async () => {
		await expect(runCommand('swarm-no-such-binary-xyz', [])).rejects.toThrow(/not found on PATH/);
	});
});
