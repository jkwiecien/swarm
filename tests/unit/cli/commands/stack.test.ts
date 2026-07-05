import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/cli/_shared/exec.js', () => ({ runCommand: vi.fn(async () => 0) }));

import { runCommand } from '@/cli/_shared/exec.js';
import { run as logsRun } from '@/cli/commands/logs.js';
import { run as startRun } from '@/cli/commands/start.js';
import { run as statusRun } from '@/cli/commands/status.js';
import { run as stopRun } from '@/cli/commands/stop.js';

const anyCwd = expect.objectContaining({ cwd: expect.any(String) });

describe('swarm start', () => {
	beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

	it('runs `docker compose up -d`', async () => {
		expect(await startRun([])).toBe(0);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'up', '-d'], anyCwd);
	});

	it('adds --build with the flag', async () => {
		await startRun(['--build']);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'up', '-d', '--build'], anyCwd);
	});
});

describe('swarm stop', () => {
	beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

	it('runs `docker compose down`, preserving volumes by default', async () => {
		await stopRun([]);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'down'], anyCwd);
	});

	it('adds --volumes with -v', async () => {
		await stopRun(['-v']);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'down', '--volumes'], anyCwd);
	});
});

describe('swarm logs', () => {
	it('runs `docker compose logs`', async () => {
		await logsRun([]);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'logs'], anyCwd);
	});

	it('supports --follow and a service name', async () => {
		await logsRun(['-f', 'router']);
		expect(runCommand).toHaveBeenCalledWith(
			'docker',
			['compose', 'logs', '--follow', 'router'],
			anyCwd,
		);
	});
});

describe('swarm status', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('runs `docker compose ps` and reports a healthy router', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, status: 200 }) as Response),
		);
		expect(await statusRun([])).toBe(0);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'ps'], anyCwd);
	});

	it('does not throw when the router is unreachable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ECONNREFUSED');
			}),
		);
		expect(await statusRun([])).toBe(0);
	});
});
