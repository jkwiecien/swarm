import { describe, expect, it } from 'vitest';
import { isVerifiableRole, maskedPreview, sameVerifiedLogin } from './credentials.js';

describe('isVerifiableRole', () => {
	it('marks the two PAT roles verifiable', () => {
		expect(isVerifiableRole('implementer')).toBe(true);
		expect(isVerifiableRole('reviewer')).toBe(true);
	});

	it('does not mark the webhook secret verifiable', () => {
		expect(isVerifiableRole('webhookSecret')).toBe(false);
	});
});

describe('maskedPreview', () => {
	it('reshapes the server ****last4 mask into dot form', () => {
		expect(maskedPreview('****abcd')).toBe('•••• abcd');
	});

	it('shows bare dots when the server withheld the last-4 (short value)', () => {
		expect(maskedPreview('****')).toBe('••••');
	});
});

describe('sameVerifiedLogin', () => {
	it('returns false until both logins are known', () => {
		expect(sameVerifiedLogin(undefined, undefined)).toBe(false);
		expect(sameVerifiedLogin('octocat', undefined)).toBe(false);
		expect(sameVerifiedLogin(undefined, 'octocat')).toBe(false);
	});

	it('flags identical logins case-insensitively', () => {
		expect(sameVerifiedLogin('octocat', 'octocat')).toBe(true);
		expect(sameVerifiedLogin('OctoCat', 'octocat')).toBe(true);
	});

	it('passes when the two PATs resolve to distinct logins', () => {
		expect(sameVerifiedLogin('implementer-bot', 'reviewer-bot')).toBe(false);
	});
});
