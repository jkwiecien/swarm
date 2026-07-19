import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyGitHubSignature, verifyHmac } from '@/webhook/signature-verification.js';

const SECRET = 'test-webhook-secret';
const BODY = '{"action":"opened","number":1}';

/** Compute the `sha256=<hex>` signature GitHub would send for a body/secret. */
function githubSignature(body: string, secret: string): string {
	return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('verifyGitHubSignature', () => {
	it('accepts a signature computed with the matching secret', () => {
		expect(verifyGitHubSignature(BODY, githubSignature(BODY, SECRET), SECRET)).toBe(true);
	});

	it('rejects a signature computed with a different secret', () => {
		expect(verifyGitHubSignature(BODY, githubSignature(BODY, 'wrong'), SECRET)).toBe(false);
	});

	it('rejects when the body was tampered with after signing', () => {
		const sig = githubSignature(BODY, SECRET);
		expect(verifyGitHubSignature(`${BODY} `, sig, SECRET)).toBe(false);
	});

	it('rejects an empty signature', () => {
		expect(verifyGitHubSignature(BODY, '', SECRET)).toBe(false);
	});

	it('rejects a signature missing the sha256= prefix', () => {
		const bare = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
		expect(verifyGitHubSignature(BODY, bare, SECRET)).toBe(false);
	});

	it('rejects a signature of the wrong length without throwing', () => {
		expect(verifyGitHubSignature(BODY, 'sha256=deadbeef', SECRET)).toBe(false);
	});
});

describe('verifyHmac', () => {
	it('supports base64 encoding without a prefix', () => {
		const digest = createHmac('sha1', SECRET).update(BODY, 'utf8').digest('base64');
		expect(
			verifyHmac({
				algorithm: 'sha1',
				data: BODY,
				secret: SECRET,
				signature: digest,
				encoding: 'base64',
			}),
		).toBe(true);
	});
});
