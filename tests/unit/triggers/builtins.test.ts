import { describe, expect, it } from 'vitest';
import { registerBuiltInTriggers } from '@/triggers/builtins.js';
import { createTriggerRegistry } from '@/triggers/registry.js';

describe('registerBuiltInTriggers', () => {
	it('registers the three pipeline-phase handlers', () => {
		const registry = createTriggerRegistry();
		registerBuiltInTriggers(registry);

		const names = registry.getHandlers().map((h) => h.name);
		expect(names).toEqual(['pr-review', 'pr-review-submitted', 'pm-status-changed']);
	});

	it('registers every handler with a description', () => {
		const registry = createTriggerRegistry();
		registerBuiltInTriggers(registry);

		for (const handler of registry.getHandlers()) {
			expect(handler.description.length).toBeGreaterThan(0);
		}
	});
});
