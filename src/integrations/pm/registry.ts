/**
 * pmProviderRegistry — the process-singleton registry of PM provider manifests.
 *
 * Providers register themselves at module-load time via `registerPMProvider()`
 * (see each provider's `index.ts`); shared code — the router today, more
 * surfaces later — looks them up by `id` through `getPMProvider()` /
 * `listPMProviders()` instead of hardcoding a concrete provider. This is the
 * "adding a provider never requires editing dispatch code" invariant from
 * ai/CODING_STANDARDS.md "Module shape for a provider".
 *
 * Mirrors Cascade's `src/integrations/pm/registry.ts`, trimmed to SWARM's MVP
 * (no cross-category `integrationRegistry` mirror — SWARM has only PM on the
 * manifest pattern for now).
 *
 * Duplicate-id registrations throw — that's how a provider module cloned from a
 * sibling but not renamed gets caught at startup rather than silently shadowing
 * the original.
 */

import type { PMProviderManifest } from './manifest.js';

const registry: PMProviderManifest[] = [];
const byId = new Map<string, PMProviderManifest>();

export function registerPMProvider(manifest: PMProviderManifest): void {
	if (byId.has(manifest.id)) {
		throw new Error(
			`PM provider '${manifest.id}' already registered — duplicate ids are not allowed`,
		);
	}
	registry.push(manifest);
	byId.set(manifest.id, manifest);
}

/** Look up a registered manifest by id, or `null` when none is registered. */
export function getPMProvider(id: string): PMProviderManifest | null {
	return byId.get(id) ?? null;
}

export function listPMProviders(): readonly PMProviderManifest[] {
	// Return a shallow clone so callers can't splice the source array.
	return registry.slice();
}

/**
 * Test-only helper. Production code MUST NOT call this. Clears the registry
 * between tests so registrations from one test don't leak into the next.
 */
export function _resetPMProviderRegistryForTesting(): void {
	registry.length = 0;
	byId.clear();
}
