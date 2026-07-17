import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/appSettingsRepository.js', () => ({
	getAppSettings: vi.fn(),
	updateAppSettings: vi.fn(),
}));
vi.mock('@/harness/quota-discovery.js', () => ({
	discoverCliQuotas: vi.fn(async () => []),
}));
vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	upsertCliQuota: vi.fn(async () => undefined),
}));

import { settingsRouter } from '@/api/routers/settings.js';
import type { AppSettings } from '@/config/app-settings.js';
import { getAppSettings, updateAppSettings } from '@/db/repositories/appSettingsRepository.js';

describe('settingsRouter', () => {
	const caller = settingsRouter.createCaller({});

	beforeEach(() => {
		vi.mocked(getAppSettings).mockReset();
		vi.mocked(updateAppSettings).mockReset();
	});

	describe('get', () => {
		it('returns whatever getAppSettings resolves', async () => {
			const settings: AppSettings = {
				agents: { defaults: { claude: 'opus' } },
				appearance: { theme: 'dark' },
			};
			vi.mocked(getAppSettings).mockResolvedValue(settings);

			const result = await caller.get();
			expect(result).toEqual(settings);
			expect(getAppSettings).toHaveBeenCalledTimes(1);
		});

		it('returns the defaults when nothing is stored', async () => {
			const defaults: AppSettings = { appearance: { theme: 'dark' } };
			vi.mocked(getAppSettings).mockResolvedValue(defaults);

			const result = await caller.get();
			expect(result).toEqual(defaults);
		});
	});

	describe('update', () => {
		it('validates input and passes it to updateAppSettings', async () => {
			const settings: AppSettings = {
				agents: { defaults: { claude: 'sonnet' } },
				appearance: { theme: 'light' },
			};
			vi.mocked(updateAppSettings).mockResolvedValue(settings);

			const result = await caller.update(settings);
			expect(result).toEqual(settings);
			expect(updateAppSettings).toHaveBeenCalledWith(settings);
		});

		it('rejects a model not valid for its cli before touching the repository', async () => {
			await expect(
				caller.update({ agents: { defaults: { claude: 'gpt-5.6-terra' } } } as AppSettings),
			).rejects.toThrow();
			expect(updateAppSettings).not.toHaveBeenCalled();
		});
	});
});
