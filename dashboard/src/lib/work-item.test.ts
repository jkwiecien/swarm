import { describe, expect, it } from 'vitest';
import { parseWorkItemRef, workItemLabel } from './work-item.js';

describe('parseWorkItemRef', () => {
	it('parses an issue URL', () => {
		expect(parseWorkItemRef('https://github.com/acme/widgets/issues/42')).toEqual({
			kind: 'issue',
			number: '42',
		});
	});

	it('parses a pull request URL', () => {
		expect(parseWorkItemRef('https://github.com/acme/widgets/pull/17')).toEqual({
			kind: 'pr',
			number: '17',
		});
	});

	it.each([
		['https://github.com/acme/widgets/pull/17/files', { kind: 'pr', number: '17' }],
		[
			'https://github.com/acme/widgets/issues/42?notification_referrer_id=1',
			{ kind: 'issue', number: '42' },
		],
		['https://github.com/acme/widgets/issues/42#issuecomment-1', { kind: 'issue', number: '42' }],
	])('parses a URL with a suffix: %s', (url, expected) => {
		expect(parseWorkItemRef(url)).toEqual(expected);
	});

	it.each([
		'PVTI_lADODb1Ycc4BcNwDzgabc',
		'',
		null,
		undefined,
	])('returns null for an unusable value: %s', (url) => {
		expect(parseWorkItemRef(url)).toBeNull();
	});
});

describe('workItemLabel', () => {
	it('labels issues and pull requests semantically', () => {
		expect(workItemLabel({ kind: 'issue', number: '42' })).toBe('Issue: #42');
		expect(workItemLabel({ kind: 'pr', number: '17' })).toBe('PR: #17');
	});
});
