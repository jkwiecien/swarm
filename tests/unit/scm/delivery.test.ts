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
});
