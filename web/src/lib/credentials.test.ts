import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SCM_PROVIDER_ID,
	getScmProviderCopy,
	isVerifiableRole,
	maskedPreview,
	SCM_PROVIDERS,
	sameVerifiedLogin,
} from './credentials.js';

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

describe('SCM_PROVIDERS', () => {
	it('lists GitHub as the sole available provider', () => {
		expect(SCM_PROVIDERS).toHaveLength(1);
		expect(SCM_PROVIDERS[0]).toEqual({ id: 'github', label: 'GitHub', available: true });
	});

	it('defaults the selected provider to GitHub', () => {
		expect(DEFAULT_SCM_PROVIDER_ID).toBe('github');
	});
});

describe('getScmProviderCopy', () => {
	const copy = getScmProviderCopy('github');

	it('projects GitHub-specific role descriptions', () => {
		expect(copy.roleDescriptions.implementer).toMatch(/GitHub personal access token/);
		expect(copy.roleDescriptions.webhookSecret).toMatch(/HMAC secret/);
	});

	it('projects the verify-failure and same-account-warning copy', () => {
		expect(copy.verifyFailureMessage).toMatch(/GitHub account/);
		expect(copy.sameAccountWarningTitle('octocat')).toBe('Both PATs resolve to @octocat');
		expect(copy.sameAccountWarningBody).toMatch(/same GitHub account/);
	});
});
