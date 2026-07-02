/**
 * Config + credential resolution facade — mirrors Cascade's `src/config/provider.ts`,
 * trimmed to SWARM's single provider pair and single-user scope.
 *
 * This is the seam the router and SCM layers call: they ask for a project by
 * repo and for a persona's token, and never touch the DB repositories or the
 * `credentials`-reference indirection directly. Keeping that indirection here
 * means the rest of the code deals in `(project, persona)` and never in raw
 * env-var keys or ciphertext.
 */

import { resolveProjectCredential } from '../db/repositories/credentialsRepository.js';
import { findProjectByRepoFromDb } from '../db/repositories/projectsRepository.js';
import type { GitHubPersona } from '../github/personas.js';
import type { ProjectConfig } from './schema.js';

/**
 * Resolve the SWARM project that owns a GitHub repository (`owner/repo`).
 * Returns `undefined` when the repo isn't tracked — the router treats that as
 * "not ours", not an error.
 */
export async function findProjectByRepo(repo: string): Promise<ProjectConfig | undefined> {
	return findProjectByRepoFromDb(repo);
}

/**
 * Resolve a persona's GitHub token for a project, or `null` if the reference
 * resolves to no stored credential.
 *
 * The config's `credentials` block holds the *reference* (an env-var key) for
 * each persona; this maps persona → reference → secret. The implementer/reviewer
 * split is the whole point (ai/CODING_STANDARDS.md "Loop prevention"): the two
 * personas must resolve to two distinct tokens so neither reacts to its own
 * output.
 */
export async function getPersonaTokenOrNull(
	project: ProjectConfig,
	persona: GitHubPersona,
): Promise<string | null> {
	const envVarKey = project.credentials[persona];
	return resolveProjectCredential(project.id, envVarKey);
}

/**
 * Resolve a persona's GitHub token for a project. Throws if the reference
 * resolves to no stored credential — an operation that needs a persona token
 * but has none configured is a deployment error, not a soft "not found"
 * (ai/CODING_STANDARDS.md "Error handling").
 */
export async function getPersonaToken(
	project: ProjectConfig,
	persona: GitHubPersona,
): Promise<string> {
	const token = await getPersonaTokenOrNull(project, persona);
	if (!token) {
		throw new Error(
			`No GitHub ${persona} token configured for project '${project.id}' ` +
				`(credential reference '${project.credentials[persona]}' not found in project_credentials)`,
		);
	}
	return token;
}
