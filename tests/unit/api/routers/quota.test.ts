import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	getAllCliQuotas: vi.fn(),
	upsertCliQuota: vi.fn(),
}));

vi.mock('@/harness/quota-discovery.js', () => ({
	discoverCliQuotas: vi.fn(),
}));

import { quotaRouter } from '@/api/routers/quota.js';
import { getAllCliQuotas, upsertCliQuota } from '@/db/repositories/cliQuotasRepository.js';
import type { CliQuotaSnapshot } from '@/harness/quota.js';
import { discoverCliQuotas } from '@/harness/quota-discovery.js';

describe('quotaRouter', () => {
	const caller = quotaRouter.createCaller({});

	beforeEach(() => {
		vi.mocked(getAllCliQuotas).mockReset();
		vi.mocked(upsertCliQuota).mockReset();
		vi.mocked(discoverCliQuotas).mockReset();
	});

	describe('getQuotas', () => {
		it('returns all persisted cli quotas', async () => {
			const mockSnapshots: CliQuotaSnapshot[] = [
				{
					cli: 'codex',
					status: 'available',
					source: 'live',
					lastUpdated: new Date().toISOString(),
				},
			];
			vi.mocked(getAllCliQuotas).mockResolvedValue(mockSnapshots);

			const result = await caller.getQuotas();
			expect(result).toEqual(mockSnapshots);
			expect(getAllCliQuotas).toHaveBeenCalledTimes(1);
		});
	});

	describe('refreshQuotas', () => {
		it('triggers a full CLI discovery, upserts each snapshot, and returns the result', async () => {
			const mockSnapshots: CliQuotaSnapshot[] = [
				{
					cli: 'claude',
					status: 'available',
					source: 'fallback',
					lastUpdated: new Date().toISOString(),
				},
				{
					cli: 'codex',
					status: 'unavailable',
					source: 'fallback',
					lastUpdated: new Date().toISOString(),
				},
			];
			vi.mocked(discoverCliQuotas).mockResolvedValue(mockSnapshots);

			const result = await caller.refreshQuotas();

			expect(discoverCliQuotas).toHaveBeenCalledWith(false); // cheap = false for manual refresh
			expect(upsertCliQuota).toHaveBeenCalledTimes(2);
			expect(upsertCliQuota).toHaveBeenLastCalledWith(
				mockSnapshots[1].cli,
				mockSnapshots[1].status,
				mockSnapshots[1],
			);
			expect(result).toEqual(mockSnapshots);
		});
	});
});
