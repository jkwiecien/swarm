/**
 * Credential CRUD + resolution over Postgres — mirrors Cascade's
 * `src/db/repositories/credentialsRepository.ts`, trimmed to SWARM's single-user
 * scope (one credential set per project, no org layer — ai/ARCHITECTURE.md
 * "Single-user scope"; PROJECT.md §6.1).
 *
 * A project's config stores only *references* — env-var keys — in its
 * `credentials` block (`src/config/schema.ts`). This layer turns a
 * `(projectId, envVarKey)` reference into the actual secret by looking up the
 * `project_credentials` row and decrypting its value with `projectId` as AAD
 * (`src/db/crypto.ts`). Writes encrypt transparently with the same AAD, so
 * callers only ever handle plaintext and ciphertext never leaves this module.
 * Secrets never travel through function signatures beyond this point — callers
 * scope them via `AsyncLocalStorage` (ai/CODING_STANDARDS.md "Scope credentials
 * with AsyncLocalStorage").
 */

import { and, eq } from 'drizzle-orm';

import { getDb } from '../client.js';
import { decryptCredential, encryptCredential } from '../crypto.js';
import { projectCredentials } from '../schema/projectCredentials.js';
import { projects } from '../schema/projects.js';

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

/**
 * Resolve every credential for a project as a flat env-var-key → plaintext map
 * — the shape the worker grafts into an agent CLI's environment. Unlike the
 * single-key lookup, an unknown `projectId` throws: asking for *all* credentials
 * of a project that doesn't exist is a caller bug, whereas an existing project
 * with zero credentials legitimately resolves to `{}`. Without the existence
 * check the two cases would be indistinguishable.
 */
export async function resolveAllProjectCredentials(
	projectId: string,
): Promise<Record<string, string>> {
	const db = getDb();

	const projectRows = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!projectRows[0]) {
		throw new Error(`Project not found: ${projectId}`);
	}

	const rows = await db
		.select({ envVarKey: projectCredentials.envVarKey, value: projectCredentials.value })
		.from(projectCredentials)
		.where(eq(projectCredentials.projectId, projectId));

	const resolved: Record<string, string> = {};
	for (const row of rows) {
		resolved[row.envVarKey] = decryptCredential(row.value, projectId);
	}
	return resolved;
}

/**
 * Write (upsert) a project credential. The plaintext is encrypted with
 * `projectId` as AAD before it touches the table (`src/db/crypto.ts`), and the
 * unique index on `(project_id, env_var_key)` makes a repeat write for the same
 * key an update — one value per key per project.
 */
export async function writeProjectCredential(
	projectId: string,
	envVarKey: string,
	value: string,
	name?: string | null,
): Promise<void> {
	const encryptedValue = encryptCredential(value, projectId);
	await getDb()
		.insert(projectCredentials)
		.values({ projectId, envVarKey, value: encryptedValue, name: name ?? null })
		.onConflictDoUpdate({
			target: [projectCredentials.projectId, projectCredentials.envVarKey],
			set: { value: encryptedValue, name: name ?? null, updatedAt: new Date() },
		});
}

/**
 * Delete a project credential. Deleting a key that was never written is a
 * no-op, not an error — the end state is the same either way.
 */
export async function deleteProjectCredential(projectId: string, envVarKey: string): Promise<void> {
	await getDb()
		.delete(projectCredentials)
		.where(
			and(eq(projectCredentials.projectId, projectId), eq(projectCredentials.envVarKey, envVarKey)),
		);
}
