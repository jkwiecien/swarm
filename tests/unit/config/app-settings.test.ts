import { describe, expect, it } from 'vitest';
import {
	APP_SETTINGS_DEFAULTS,
	AppSettingsSchema,
	validateAppSettings,
} from '@/config/app-settings.js';

describe('AppSettingsSchema', () => {
	it('accepts an empty settings object (all defaults)', () => {
		expect(AppSettingsSchema.safeParse({}).success).toBe(true);
	});

	it('accepts a valid global agents.defaults block', () => {
		const parsed = validateAppSettings({
			agents: {
				defaults: {
					claude: 'opus',
					antigravity: 'Gemini 3.5 Flash (Medium)',
					codex: 'gpt-5.6-terra',
				},
			},
		});
		expect(parsed.agents?.defaults?.claude).toBe('opus');
	});

	it('rejects a model not in the known list for its cli', () => {
		expect(
			AppSettingsSchema.safeParse({ agents: { defaults: { claude: 'gpt-5.6-terra' } } }).success,
		).toBe(false);
	});

	it('rejects an unknown cli key in the defaults block', () => {
		expect(AppSettingsSchema.safeParse({ agents: { defaults: { gpt: 'sonnet' } } }).success).toBe(
			false,
		);
	});

	it('validateAppSettings throws on malformed input', () => {
		expect(() => validateAppSettings({ agents: { defaults: { claude: 'nonsense' } } })).toThrow();
	});

	it('APP_SETTINGS_DEFAULTS is a valid, empty settings object', () => {
		expect(AppSettingsSchema.safeParse(APP_SETTINGS_DEFAULTS).success).toBe(true);
		expect(APP_SETTINGS_DEFAULTS).toEqual({});
	});
});
