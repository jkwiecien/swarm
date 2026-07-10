import { beforeEach, describe, expect, it } from 'vitest';

import { APP_SETTINGS_DEFAULTS } from '../../../src/config/app-settings.js';
import {
	getAppSettings,
	updateAppSettings,
} from '../../../src/db/repositories/appSettingsRepository.js';
import { truncateAll } from '../helpers/db.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('appSettingsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	describe('getAppSettings', () => {
		it('returns the coded defaults when no row exists', async () => {
			expect(await getAppSettings()).toEqual(APP_SETTINGS_DEFAULTS);
		});
	});

	describe('updateAppSettings', () => {
		it('round-trips the stored settings', async () => {
			const settings = { agents: { defaults: { claude: 'opus' } } };
			const returned = await updateAppSettings(settings);

			expect(returned).toEqual(settings);
			expect(await getAppSettings()).toEqual(settings);
		});

		it('is an idempotent upsert — a second write replaces the first in place', async () => {
			await updateAppSettings({ agents: { defaults: { claude: 'opus' } } });
			await updateAppSettings({ agents: { defaults: { claude: 'sonnet' } } });

			expect(await getAppSettings()).toEqual({ agents: { defaults: { claude: 'sonnet' } } });
		});
	});
});
