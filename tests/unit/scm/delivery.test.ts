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
		saveDeliveryProgress(root, { deliveryId, pushed: true, commitSha: 'abc1234' });
		expect(loadDeliveryProgress(root, deliveryId)).toEqual({
			deliveryId,
			pushed: true,
			commitSha: 'abc1234',
		});
		expect(readFileSync(join(root, '.swarm_delivery.json'), 'utf8')).not.toContain('token');
	});

	it('commits with the selected persona rather than ambient git config', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		execFileSync('git', ['init'], { cwd: root });
		execFileSync('git', ['config', 'user.name', 'Ambient User'], { cwd: root });
		execFileSync('git', ['config', 'user.email', 'ambient@example.com'], { cwd: root });
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		const sha = await commitPreparedTree(root, 'feat: deliver', {
			name: 'swarm-implementer',
			email: 'swarm-implementer@users.noreply.github.com',
		});
		const identity = execFileSync('git', ['show', '-s', '--format=%an <%ae>|%cn <%ce>', sha], {
			cwd: root,
			encoding: 'utf8',
		}).trim();
		expect(identity).toBe(
			'swarm-implementer <swarm-implementer@users.noreply.github.com>|swarm-implementer <swarm-implementer@users.noreply.github.com>',
		);
	});

	it('excludes every delegation lifecycle artifact from a delegated prepared tree', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		execFileSync('git', ['init'], { cwd: root });
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		writeFileSync(join(root, '.swarm-delegation-events.jsonl'), '{}\n');
		writeFileSync(join(root, '.swarm-delegation-review.json'), '{}\n');
		writeFileSync(join(root, '.swarm-delegation-agent-123.start'), '{}\n');

		const sha = await commitPreparedTree(root, 'feat: delegated delivery', {
			name: 'swarm-implementer',
			email: 'swarm-implementer@users.noreply.github.com',
		});
		const committed = execFileSync('git', ['show', '--format=', '--name-only', sha], {
			cwd: root,
			encoding: 'utf8',
		});
		expect(committed.trim()).toBe('change.txt');
		expect(
			execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
		).toContain('?? .swarm-delegation-agent-123.start');
	});

	it('rejects a tracked delegation lifecycle artifact', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		execFileSync('git', ['init'], { cwd: root });
		execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
		execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
		writeFileSync(join(root, '.swarm-delegation-events.jsonl'), '{}\n');
		execFileSync('git', ['add', '.swarm-delegation-events.jsonl'], { cwd: root });
		execFileSync('git', ['commit', '-m', 'test: track scratch'], { cwd: root });
		writeFileSync(join(root, 'change.txt'), 'prepared\n');

		await expect(
			commitPreparedTree(root, 'feat: unsafe delivery', {
				name: 'swarm-implementer',
				email: 'swarm-implementer@users.noreply.github.com',
			}),
		).rejects.toThrow('scratch artifact is tracked');
	});
});
