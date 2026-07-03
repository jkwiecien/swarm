import { describe, expect, it } from 'vitest';

import { _resetPMProviderRegistryForTesting } from '@/integrations/pm/registry.js';
import { createWebhookApp } from '@/router/webhook-receiver.js';

// `createWebhookApp` side-effect imports the entrypoint, so github-projects is
// normally registered by the time `resolvePmAdapter()` runs — the happy path is
// covered by the "defaultDeps wiring" tests. This isolated file clears the
// registry first (Vitest isolates module state per file, so the reset can't leak
// into other suites) to exercise the otherwise-unreachable guard clause and pin
// its diagnostic message.
describe('createWebhookApp — missing PM provider registration', () => {
	it('throws a helpful error when the github-projects manifest is absent', () => {
		_resetPMProviderRegistryForTesting();
		expect(() => createWebhookApp()).toThrow(/'github-projects' is not registered/);
	});
});
