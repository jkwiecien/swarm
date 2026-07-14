import { describe, expect, it } from 'vitest';
import { SPLIT_CHILD_LABEL } from '@/pipeline/planning.js';
import {
	buildPreplanContract,
	embedPreplanMarker,
	evaluatePreplan,
	hashDescription,
	isPreplanSkip,
	type PreplanContract,
	REPLAN_LABEL,
} from '@/pipeline/preplan.js';
import type { WorkItem } from '@/pm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

const ITEM_URL = 'https://github.com/o/r/issues/42';
const HUMAN = 'Build the UI slice, self-contained.';
const PLAN = '# UI plan\n\n1. Do the thing.';

function contract(overrides: Partial<PreplanContract> = {}): PreplanContract {
	return {
		...buildPreplanContract({
			splitId: 'split-abc',
			childIndex: 1,
			parentUrl: 'https://github.com/o/r/issues/18',
			itemUrl: ITEM_URL,
			humanDescription: HUMAN,
			plan: PLAN,
			generatedAt: '2026-07-14T00:00:00.000Z',
		}),
		...overrides,
	};
}

/** A work item whose body embeds `c` after `human`, with the split-child label. */
function childWith(c: PreplanContract, human = HUMAN, overrides: Partial<WorkItem> = {}): WorkItem {
	return createMockWorkItem({
		url: ITEM_URL,
		description: embedPreplanMarker(human, c),
		labels: [{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL }],
		...overrides,
	});
}

describe('hashDescription', () => {
	it('is stable across trivial whitespace/line-ending churn', () => {
		expect(hashDescription('a\r\nb')).toBe(hashDescription('a\nb'));
		expect(hashDescription('  hello  ')).toBe(hashDescription('hello'));
	});

	it('changes when the content materially changes', () => {
		expect(hashDescription('scope A')).not.toBe(hashDescription('scope B'));
	});
});

describe('embedPreplanMarker / evaluatePreplan round-trip', () => {
	it('embeds an invisible marker while preserving the human description', () => {
		const body = embedPreplanMarker(HUMAN, contract());
		expect(body).toContain(HUMAN);
		expect(body).toContain('swarm-preplan:v1');
		// The human part comes first; the marker is an HTML comment (hidden when rendered).
		expect(body.indexOf(HUMAN)).toBeLessThan(body.indexOf('swarm-preplan'));
		expect(body.trimEnd().endsWith('-->')).toBe(true);
	});

	it('accepts a valid marker and returns the contract for the skip path', () => {
		const decision = evaluatePreplan(childWith(contract()));
		expect(isPreplanSkip(decision)).toBe(true);
		if (isPreplanSkip(decision)) {
			expect(decision.contract.plan).toBe(PLAN);
			expect(decision.contract.splitId).toBe('split-abc');
		}
	});

	it('handles an empty human description (marker only)', () => {
		const c = buildPreplanContract({
			splitId: 's',
			childIndex: 0,
			parentUrl: 'p',
			itemUrl: ITEM_URL,
			humanDescription: '',
			plan: PLAN,
			generatedAt: 't',
		});
		const decision = evaluatePreplan(childWith(c, ''));
		expect(isPreplanSkip(decision)).toBe(true);
	});
});

describe('evaluatePreplan fallbacks', () => {
	it('falls back (no reason) when there is no marker at all', () => {
		const decision = evaluatePreplan(createMockWorkItem({ description: 'just a plain body' }));
		expect(decision).toEqual({ fallbackReason: null });
	});

	it('falls back when the marker JSON is malformed', () => {
		const item = createMockWorkItem({
			url: ITEM_URL,
			description: 'body\n\n<!-- swarm-preplan:v1\n{ nope\n-->',
		});
		expect(evaluatePreplan(item)).toEqual({ fallbackReason: 'preplan marker is malformed' });
	});

	it('falls back when a required field is missing (schema rejects it)', () => {
		const item = createMockWorkItem({
			url: ITEM_URL,
			description: 'body\n\n<!-- swarm-preplan:v1\n{"version":1}\n-->',
		});
		expect(evaluatePreplan(item)).toEqual({ fallbackReason: 'preplan marker is malformed' });
	});

	it('falls back when the marker belongs to a different item (url mismatch)', () => {
		const item = childWith(contract(), HUMAN, { url: 'https://github.com/o/r/issues/999' });
		expect(evaluatePreplan(item)).toEqual({
			fallbackReason: 'preplan marker does not belong to this item',
		});
	});

	it('falls back when the human description changed after generation (hash mismatch)', () => {
		const c = contract();
		const item = childWith(c, 'Completely different scope now.');
		expect(evaluatePreplan(item)).toEqual({
			fallbackReason: 'child scope changed since the preplan was generated',
		});
	});

	it('falls back when the operator applied the replan label', () => {
		const item = childWith(contract(), HUMAN, {
			labels: [
				{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL },
				{ id: REPLAN_LABEL, name: REPLAN_LABEL },
			],
		});
		const decision = evaluatePreplan(item);
		expect(isPreplanSkip(decision)).toBe(false);
		expect((decision as { fallbackReason: string }).fallbackReason).toContain(REPLAN_LABEL);
	});
});

describe('buildPreplanContract', () => {
	it('computes the description hash from the human description', () => {
		const c = contract();
		expect(c.descriptionHash).toBe(hashDescription(HUMAN));
	});

	it('rejects an empty plan', () => {
		expect(() =>
			buildPreplanContract({
				splitId: 's',
				childIndex: 0,
				parentUrl: 'p',
				itemUrl: ITEM_URL,
				humanDescription: HUMAN,
				plan: '   ',
				generatedAt: 't',
			}),
		).toThrow();
	});
});
