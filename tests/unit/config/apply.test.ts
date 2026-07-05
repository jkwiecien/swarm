import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	upsertProjectToDb: vi.fn(async () => undefined),
}));
vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	writeProjectCredential: vi.fn(async () => undefined),
}));

import { applyConfig } from '@/config/apply.js';
import { SwarmConfigSchema } from '@/config/schema.js';
import { writeProjectCredential } from '@/db/repositories/credentialsRepository.js';
import { upsertProjectToDb } from '@/db/repositories/projectsRepository.js';

const project = createMockProjectConfig({
	id: 'proj-1',
	credentials: {
		implementer: 'IMPL_KEY',
		reviewer: 'REV_KEY',
		webhookSecret: 'HOOK_KEY',
	},
});
const config = SwarmConfigSchema.parse({ projects: [project] });

describe('applyConfig', () => {
	beforeEach(() => {
		vi.mocked(upsertProjectToDb).mockClear();
		vi.mocked(writeProjectCredential).mockClear();
		process.env.IMPL_KEY = 'ghp_impl';
		process.env.REV_KEY = 'ghp_rev';
		process.env.HOOK_KEY = 'whsec';
	});

	afterEach(() => {
		delete process.env.IMPL_KEY;
		delete process.env.REV_KEY;
		delete process.env.HOOK_KEY;
	});

	it('upserts each project and stores every referenced credential from the environment', async () => {
		const result = await applyConfig(config);

		expect(upsertProjectToDb).toHaveBeenCalledWith(project);
		expect(result.projects).toEqual(['proj-1']);
		expect(result.credentialsWritten).toBe(3);
		expect(result.credentialsSkipped).toEqual([]);
		expect(writeProjectCredential).toHaveBeenCalledWith('proj-1', 'IMPL_KEY', 'ghp_impl');
		expect(writeProjectCredential).toHaveBeenCalledWith('proj-1', 'REV_KEY', 'ghp_rev');
		expect(writeProjectCredential).toHaveBeenCalledWith('proj-1', 'HOOK_KEY', 'whsec');
	});

	it('skips (does not write) a credential reference whose env var is unset', async () => {
		delete process.env.REV_KEY;

		const result = await applyConfig(config);

		expect(result.credentialsWritten).toBe(2);
		expect(result.credentialsSkipped).toEqual(['proj-1/REV_KEY']);
		expect(writeProjectCredential).not.toHaveBeenCalledWith('proj-1', 'REV_KEY', expect.anything());
	});

	it('treats an empty-string env var as unset', async () => {
		process.env.HOOK_KEY = '';

		const result = await applyConfig(config);

		expect(result.credentialsSkipped).toEqual(['proj-1/HOOK_KEY']);
	});

	it('dedupes references so a key shared by two personas is written once', async () => {
		const shared = createMockProjectConfig({
			id: 'proj-2',
			credentials: { implementer: 'SHARED', reviewer: 'SHARED', webhookSecret: 'HOOK_KEY' },
		});
		process.env.SHARED = 'ghp_shared';

		const result = await applyConfig(SwarmConfigSchema.parse({ projects: [shared] }));

		expect(result.credentialsWritten).toBe(2);
		expect(
			vi.mocked(writeProjectCredential).mock.calls.filter(([, key]) => key === 'SHARED'),
		).toHaveLength(1);
		delete process.env.SHARED;
	});

	it('applies every project in the config', async () => {
		const other = createMockProjectConfig({ id: 'proj-3', repo: 'owner/other' });
		const result = await applyConfig(SwarmConfigSchema.parse({ projects: [project, other] }));

		expect(upsertProjectToDb).toHaveBeenCalledTimes(2);
		expect(result.projects).toEqual(['proj-1', 'proj-3']);
	});
});
