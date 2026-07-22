import { describe, expect, it } from 'vitest';

import {
	DEFAULT_AUTOMATION_LABEL,
	hasAutomationLabel,
	missingAutomationLabelMessage,
	resolveAutomationLabel,
} from '@/pm/automation-label.js';
import { createMockWorkItem } from '../../helpers/factories.js';

describe('resolveAutomationLabel', () => {
	it('defaults to the coded label when the project has no pipeline block', () => {
		expect(resolveAutomationLabel(undefined)).toBe(DEFAULT_AUTOMATION_LABEL);
	});

	it('defaults to the coded label when the pipeline block omits it', () => {
		expect(resolveAutomationLabel({ planning: { autoAdvance: true } })).toBe(
			DEFAULT_AUTOMATION_LABEL,
		);
	});

	it('uses the project-configured label', () => {
		expect(resolveAutomationLabel({ automationLabel: 'automate' })).toBe('automate');
	});

	it('treats an explicitly empty string as "gate disabled"', () => {
		expect(resolveAutomationLabel({ automationLabel: '' })).toBeUndefined();
	});
});

describe('hasAutomationLabel', () => {
	it('is true when the item carries the label', () => {
		const item = createMockWorkItem({ labels: [{ id: 'LA_1', name: 'swarm' }] });
		expect(hasAutomationLabel(item, 'swarm')).toBe(true);
	});

	it('is false when the item carries no labels at all', () => {
		expect(hasAutomationLabel(createMockWorkItem({ labels: [] }), 'swarm')).toBe(false);
	});

	it('matches case-sensitively rather than guessing', () => {
		const item = createMockWorkItem({ labels: [{ id: 'LA_1', name: 'Swarm' }] });
		expect(hasAutomationLabel(item, 'swarm')).toBe(false);
	});

	it('requires the whole label name, not a prefix of another label', () => {
		const item = createMockWorkItem({ labels: [{ id: 'LA_1', name: 'swarm:split-child' }] });
		expect(hasAutomationLabel(item, 'swarm')).toBe(false);
	});
});

describe('missingAutomationLabelMessage', () => {
	it('names the label a human has to add', () => {
		expect(missingAutomationLabelMessage('automate')).toContain("'automate'");
	});
});
