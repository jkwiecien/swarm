/**
 * Credential resolution from Postgres — mirrors the read side of Cascade's
 * `src/db/repositories/credentialsRepository.ts`, trimmed to SWARM's single-user
 * scope (one credential set per project, no org layer — ai/ARCHITECTURE.md
 * "Single-user scope"; PROJECT.md §6.1).
 *
 * A project's config stores only *references* — env-var keys — in its
 * `credentials` block (`src/config/schema.ts`). This layer turns a
 * `(projectId, envVarKey)` reference into the actual secret by looking up the
 * `project_credentials` row and decrypting its value with `projectId` as AAD
 * (`src/db/crypto.ts`). Secrets never travel through function signatures beyond
 * this point — callers scope them via `AsyncLocalStorage`
 * (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 */

import { and, eq } from 'drizzle-orm';

import { getDb } from '../client.js';
import { decryptCredential } from '../crypto.js';
import { projectCredentials } from '../schema/projectCredentials.js';

/**
 * Resolve a single credential value for a project by its env-var-key reference.
 * Returns `null` when no row matches — a missing credential is a "not found"
 * lookup, not a programmer error (ai/CODING_STANDARDS.md "Error handling"), so
 * it's the caller's job to decide whether absence is fatal.
 *
 * The stored value is decrypted with `projectId` as AAD, so a ciphertext copied
 * into another project's row fails authentication rather than resolving.
 */
export async function resolveProjectCredential(
	projectId: string,
	envVarKey: string,
): Promise<string | null> {
	const rows = await getDb()
		.select({ value: projectCredentials.value })
		.from(projectCredentials)
		.where(
			and(eq(projectCredentials.projectId, projectId), eq(projectCredentials.envVarKey, envVarKey)),
		)
		.limit(1);

	const row = rows[0];
	if (!row) return null;

	return decryptCredential(row.value, projectId);
}
