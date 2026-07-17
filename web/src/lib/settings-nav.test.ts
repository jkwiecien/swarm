import { describe, expect, it } from 'vitest';
import {
	resolveActiveSettingsTab,
	settingsSearchSchema,
	settingsTabSearch,
} from './settings-nav.js';

describe('settingsSearchSchema', () => {
	it('yields no tab for a bare settings link', () => {
		expect(settingsSearchSchema.parse({})).toEqual({ tab: undefined });
	});

	it('parses a valid tab', () => {
		expect(settingsSearchSchema.parse({ tab: 'appearance' })).toEqual({ tab: 'appearance' });
	});

	it('falls back to undefined rather than throwing on an unknown tab', () => {
		expect(settingsSearchSchema.parse({ tab: 'nope' })).toEqual({ tab: undefined });
	});

	it('strips unknown params', () => {
		expect(settingsSearchSchema.parse({ tab: 'agents', extra: 'x' })).toEqual({ tab: 'agents' });
	});
});

describe('resolveActiveSettingsTab', () => {
	it('defaults to the Agent Defaults tab for an empty search', () => {
		expect(resolveActiveSettingsTab({})).toBe('agents');
	});

	it('honors an explicit tab', () => {
		expect(resolveActiveSettingsTab({ tab: 'appearance' })).toBe('appearance');
	});
});

describe('settingsTabSearch', () => {
	it('builds search state for a tab', () => {
		expect(settingsTabSearch('appearance')).toEqual({ tab: 'appearance' });
	});
});
