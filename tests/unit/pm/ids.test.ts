import { describe, expect, it } from 'vitest';
import {
	InvalidIdError,
	parseFieldId,
	parseProjectV2Id,
	parseSingleSelectOptionId,
	parseWorkItemId,
	unwrap,
} from '@/pm/ids.js';

describe('PM branded ID parsers', () => {
	const parsers = [
		{ name: 'parseProjectV2Id', parse: parseProjectV2Id, kind: 'ProjectV2Id' },
		{ name: 'parseFieldId', parse: parseFieldId, kind: 'FieldId' },
		{
			name: 'parseSingleSelectOptionId',
			parse: parseSingleSelectOptionId,
			kind: 'SingleSelectOptionId',
		},
		{ name: 'parseWorkItemId', parse: parseWorkItemId, kind: 'WorkItemId' },
	];

	for (const { name, parse, kind } of parsers) {
		describe(name, () => {
			it('returns the branded value unchanged for a non-empty string', () => {
				expect(unwrap(parse('PVT_abc123'))).toBe('PVT_abc123');
			});

			it('throws InvalidIdError with the right kind on empty input', () => {
				expect(() => parse('')).toThrow(InvalidIdError);
				try {
					parse('');
				} catch (err) {
					expect(err).toBeInstanceOf(InvalidIdError);
					expect((err as InvalidIdError).kind).toBe(kind);
				}
			});

			it('throws on whitespace-only input', () => {
				expect(() => parse('   ')).toThrow(InvalidIdError);
			});
		});
	}
});

describe('unwrap', () => {
	it('returns the underlying string', () => {
		expect(unwrap(parseFieldId('field-1'))).toBe('field-1');
	});
});
