import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	commitPreparedTree,
	deliveryIdentity,
	ImplementationHandoffSchema,
	loadDeliveryProgress,
	readHandoff,
	saveDeliveryProgress,
} from '@/scm/delivery.js';

const roots: string[] = [];
const fixtureGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function fixtureGit(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: fixtureGitEnvironment,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SCM delivery hand-offs', () => {
	it('validates implementation evidence before delivery', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		writeFileSync(
			join(root, 'handoff.json'),
			JSON.stringify({
				summary: 'Prepared change',
				commitSubject: 'feat: prepare change',
				verification: [{ command: 'npm test', outcome: 'passed' }],
				limitations: [],
				readyForDelivery: true,
			}),
		);
		expect(readHandoff(root, 'handoff.json', ImplementationHandoffSchema).readyForDelivery).toBe(
			true,
		);
	});

	it('rejects missing verification evidence', () => {
		expect(() =>
			ImplementationHandoffSchema.parse({
				summary: 'Prepared change',
				commitSubject: 'feat: prepare change',
				verification: [],
				readyForDelivery: true,
			}),
		).toThrow();
	});

	it('persists and reloads step-level progress under a stable identity', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		const deliveryId = deliveryIdentity(['review', 'acme/widgets', '42', 'abc']);
		saveDeliveryProgress(root, {
			deliveryId,
			pushed: true,
			commitSha: 'abc1234',
			followUpEnqueued: false,
		});
		expect(loadDeliveryProgress(root, deliveryId)).toEqual({
			deliveryId,
			pushed: true,
			commitSha: 'abc1234',
			followUpEnqueued: false,
		});
		expect(readFileSync(join(root, '.swarm_delivery.json'), 'utf8')).not.toContain('token');
	});

	it('commits with the selected persona rather than ambient git config', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		fixtureGit(root, ['init']);
		fixtureGit(root, ['config', 'user.name', 'Ambient User']);
		fixtureGit(root, ['config', 'user.email', 'ambient@example.com']);
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		const sha = await commitPreparedTree(root, 'feat: deliver', {
			name: 'swarm-implementer',
			email: 'swarm-implementer@users.noreply.github.com',
		});
		const identity = fixtureGit(root, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', sha]).trim();
		expect(identity).toBe(
			'swarm-implementer <swarm-implementer@users.noreply.github.com>|swarm-implementer <swarm-implementer@users.noreply.github.com>',
		);
	});

	it('excludes every delegation lifecycle artifact from a delegated prepared tree', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		fixtureGit(root, ['init']);
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		writeFileSync(join(root, '.swarm-delegation-events.jsonl'), '{}\n');
		writeFileSync(join(root, '.swarm-delegation-review.json'), '{}\n');
		writeFileSync(join(root, '.swarm-delegation-agent-123.start'), '{}\n');

		const sha = await commitPreparedTree(root, 'feat: delegated delivery', {
			name: 'swarm-implementer',
			email: 'swarm-implementer@users.noreply.github.com',
		});
		const committed = fixtureGit(root, ['show', '--format=', '--name-only', sha]);
		expect(committed.trim()).toBe('change.txt');
		expect(fixtureGit(root, ['status', '--porcelain'])).toContain(
			'?? .swarm-delegation-agent-123.start',
		);
	});

	it('rejects a tracked delegation lifecycle artifact', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		fixtureGit(root, ['init']);
		fixtureGit(root, ['config', 'user.name', 'Fixture']);
		fixtureGit(root, ['config', 'user.email', 'fixture@example.com']);
		writeFileSync(join(root, '.swarm-delegation-events.jsonl'), '{}\n');
		fixtureGit(root, ['add', '.swarm-delegation-events.jsonl']);
		fixtureGit(root, ['commit', '-m', 'test: track scratch']);
		writeFileSync(join(root, 'change.txt'), 'prepared\n');

		await expect(
			commitPreparedTree(root, 'feat: unsafe delivery', {
				name: 'swarm-implementer',
				email: 'swarm-implementer@users.noreply.github.com',
			}),
		).rejects.toThrow('scratch artifact is tracked');
	});
});
