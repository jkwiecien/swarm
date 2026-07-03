import { beforeEach, describe, expect, it } from 'vitest';
import type { PMProviderManifest } from '@/integrations/pm/manifest.js';
import {
	_resetPMProviderRegistryForTesting,
	getPMProvider,
	listPMProviders,
	registerPMProvider,
} from '@/integrations/pm/registry.js';

/**
 * A minimal manifest stand-in. The registry doesn't touch `configSchema` /
 * `routerAdapter`, so the tests cast a bare identity object rather than
 * constructing the real provider — keeps these unit tests about the registry's
 * bookkeeping, not the provider's wiring.
 */
function fakeManifest(id: string): PMProviderManifest {
	return { id, label: id, category: 'pm' } as unknown as PMProviderManifest;
}

describe('pmProviderRegistry', () => {
	beforeEach(() => {
		_resetPMProviderRegistryForTesting();
	});

	it('registers a manifest and looks it up by id', () => {
		const manifest = fakeManifest('github-projects');
		registerPMProvider(manifest);
		expect(getPMProvider('github-projects')).toBe(manifest);
	});

	it('returns null for an unregistered id', () => {
		expect(getPMProvider('nope')).toBeNull();
	});

	it('lists registered manifests in registration order', () => {
		registerPMProvider(fakeManifest('a'));
		registerPMProvider(fakeManifest('b'));
		expect(listPMProviders().map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('throws on a duplicate id rather than silently shadowing', () => {
		registerPMProvider(fakeManifest('github-projects'));
		expect(() => registerPMProvider(fakeManifest('github-projects'))).toThrow(/already registered/);
	});

	it('returns a copy from listPMProviders so callers cannot mutate the registry', () => {
		registerPMProvider(fakeManifest('a'));
		const list = listPMProviders() as PMProviderManifest[];
		list.push(fakeManifest('b'));
		expect(listPMProviders().map((m) => m.id)).toEqual(['a']);
	});

	it('reset clears the registry', () => {
		registerPMProvider(fakeManifest('a'));
		_resetPMProviderRegistryForTesting();
		expect(listPMProviders()).toHaveLength(0);
		expect(getPMProvider('a')).toBeNull();
	});
});
