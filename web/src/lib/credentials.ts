/**
 * Pure helpers for the project Credentials screen (issue #85). The stateful
 * query/verify logic lives in the panel component; the display projections and
 * the loop-prevention comparison are factored out here so they can be unit
 * tested without a rendered-component harness (web tests run in a node env — see
 * `web/vitest.config.ts`), mirroring the `board-mapping.ts`/`.test.ts` split.
 */

import type { Credentials } from '../../../src/config/schema.js';

/**
 * The credential references a project carries — derived from the Zod-owned
 * `CredentialsSchema` (`src/config/schema.ts`) per "Zod is the source of truth"
 * (`ai/CODING_STANDARDS.md`), so adding/removing a role in the schema surfaces
 * here as a type error. The actual env-var keys are project-configured and come
 * from `projects.credentials.list`; the role is the stable discriminator.
 */
export type CredentialRole = keyof Credentials;

/** One entry from `projects.credentials.list` (see `src/api/routers/credentials.ts`). */
export interface CredentialEntry {
	role: CredentialRole;
	envVarKey: string;
	isConfigured: boolean;
	maskedValue: string;
}

export const CREDENTIAL_ROLE_LABELS: Record<CredentialRole, string> = {
	implementer: 'Implementer PAT',
	reviewer: 'Reviewer PAT',
	webhookSecret: 'Webhook Secret',
};

export const CREDENTIAL_ROLE_DESCRIPTIONS: Record<CredentialRole, string> = {
	implementer:
		'GitHub personal access token the implementer persona commits and opens pull requests with.',
	reviewer:
		'GitHub personal access token the reviewer persona reviews with. Must resolve to a different GitHub account than the implementer for loop prevention to work.',
	webhookSecret: 'HMAC secret GitHub signs webhook deliveries with. Not tied to a GitHub identity.',
};

/**
 * Whether a role's token maps to a GitHub identity and can be verified via
 * `scm.verifyGithubToken`. The webhook secret is an HMAC secret, not a token, so
 * it has no login to resolve and no Verify affordance.
 */
export function isVerifiableRole(role: CredentialRole): boolean {
	return role === 'implementer' || role === 'reviewer';
}

/**
 * Render the collapsed masked preview for a configured credential. The server
 * already masks to `****<last4>` (or `****` for short values); this reshapes it
 * to the design-system dot form (`•••• <last4>`) without ever seeing plaintext.
 */
export function maskedPreview(maskedValue: string): string {
	const last4 = maskedValue.replace(/^\*+/, '');
	return last4 ? `•••• ${last4}` : '••••';
}

/**
 * True when both PATs have been verified in this session and resolve to the same
 * GitHub login — the condition that breaks dual-persona loop prevention. Drives a
 * non-blocking warning banner; comparison is case-insensitive because GitHub
 * logins are. Returns false until both logins are known.
 */
export function sameVerifiedLogin(
	implementerLogin: string | undefined,
	reviewerLogin: string | undefined,
): boolean {
	if (!implementerLogin || !reviewerLogin) return false;
	return implementerLogin.toLowerCase() === reviewerLogin.toLowerCase();
}
