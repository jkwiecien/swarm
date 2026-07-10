import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/appSettingsRepository.js', () => ({
	getAppSettings: vi.fn(),
	updateAppSettings: vi.fn(),
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
			const settings: AppSettings = { agents: { defaults: { claude: 'opus' } } };
			vi.mocked(getAppSettings).mockResolvedValue(settings);

			const result = await caller.get();
			expect(result).toEqual(settings);
			expect(getAppSettings).toHaveBeenCalledTimes(1);
		});

		it('returns the empty defaults when nothing is stored', async () => {
			vi.mocked(getAppSettings).mockResolvedValue({});

			const result = await caller.get();
			expect(result).toEqual({});
		});
	});

	describe('update', () => {
		it('validates input and passes it to updateAppSettings', async () => {
			const settings: AppSettings = { agents: { defaults: { claude: 'sonnet' } } };
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
