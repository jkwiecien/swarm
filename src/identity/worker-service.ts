/**
 * Provider-neutral **worker** domain surface — the seam later phases program
 * against so they never touch the `workers` table directly. The worker-side
 * companion to the identity read model (`./service.ts`) and membership read model
 * (`./membership-service.ts`), the third slice of the multi-user foundation
 * (ADR-001).
 *
 * Unlike those read-only services this one also owns the worker's credential and
 * the register/refresh writes — the same way `./auth.ts` bundles the session
 * token primitives with `createSession`, rather than splitting a two-line secret
 * into its own module. Reads (`getWorker`, `listWorkersForOwner`) and the
 * authentication seam (`resolveWorkerByCredential`) round out the surface Phase
 * 2's lease/heartbeat operations authenticate through.
 *
 * The worker credential is a high-entropy random token (not a low-entropy
 * password), so — exactly like a session token (`./auth.ts` `hashSessionToken`)
 * — it is stored as a plain SHA-256 with no salt/stretch and resolved by hash
 * lookup. It is distinct from any SCM PAT, returned in raw form **exactly once**
 * at registration (`RegisteredWorker.credential`), and never stored, logged, or
 * returned again (the same contract as `MintedSession`). Dependency-free
 * (`node:crypto`), per ai/RULES.md §2.
 */

import { createHash, randomBytes } from 'node:crypto';

import {
	createWorker,
	findWorkerByCredentialHash,
	getWorkerById,
	listWorkersForOwner as listWorkersForOwnerRows,
	updateWorkerCapabilities,
} from '../db/repositories/workersRepository.js';
import type { AgentCli } from '../harness/agent-cli.js';
import type { Worker } from './worker.js';
import { WorkerCapabilitiesSchema, WorkerDisplayNameSchema } from './worker.js';

export type { Worker } from './worker.js';

/**
 * Worker credential: 32 random bytes (256 bits) is well beyond guessing range,
 * so the stored SHA-256 needs no salt/stretch (unlike a low-entropy password) —
 * the same reasoning as `SESSION_TOKEN_BYTES` in `./auth.ts`.
 */
const CREDENTIAL_BYTES = 32;

/** SHA-256 of a raw worker credential — the only form that touches the DB. */
export function hashWorkerCredential(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

/** A freshly issued worker credential: the raw token (shown once) and its hash. */
export interface IssuedCredential {
	token: string;
	hash: string;
}

/**
 * Issue a worker credential: an opaque high-entropy token and its SHA-256. The
 * raw token is the caller's to hand to the operator once; only the hash is ever
 * persisted (mirrors `createSession` minting a session token in `./auth.ts`).
 */
export function issueWorkerCredential(): IssuedCredential {
	const token = randomBytes(CREDENTIAL_BYTES).toString('base64url');
	return { token, hash: hashWorkerCredential(token) };
}

/** The fields a caller supplies to register a worker. */
export interface RegisterWorkerInput {
	ownerUserId: string;
	displayName: string;
	capabilities: AgentCli[];
}

/**
 * A newly registered worker: the domain `Worker` (no credential material) plus
 * the raw `credential`, returned **exactly once** — it is never stored, logged,
 * or returned again (the same contract as `MintedSession`).
 */
export interface RegisteredWorker {
	worker: Worker;
	credential: string;
}

/**
 * Register a worker for an owner: validate the display name and capabilities,
 * issue a credential, persist the worker with only the credential *hash*, and
 * return the worker plus the raw credential once. A duplicate `(owner,
 * displayName)` surfaces the repository's pg `23505` for the caller to translate.
 */
export async function registerWorker(input: RegisterWorkerInput): Promise<RegisteredWorker> {
	const displayName = WorkerDisplayNameSchema.parse(input.displayName);
	const capabilities = WorkerCapabilitiesSchema.parse(input.capabilities);
	const credential = issueWorkerCredential();
	const worker = await createWorker({
		ownerUserId: input.ownerUserId,
		displayName,
		capabilities,
		credentialHash: credential.hash,
	});
	return { worker, credential: credential.token };
}

/**
 * Refresh a worker's declared capabilities. Validates the set (non-empty,
 * de-duplicated `AgentCli` values) and updates it. Returns the updated worker, or
 * `undefined` if no worker has that id.
 */
export async function refreshWorkerCapabilities(
	id: string,
	capabilities: AgentCli[],
): Promise<Worker | undefined> {
	const validated = WorkerCapabilitiesSchema.parse(capabilities);
	return updateWorkerCapabilities(id, validated);
}

/** Resolve a worker by id. Returns `undefined` if unknown. */
export async function getWorker(id: string): Promise<Worker | undefined> {
	return getWorkerById(id);
}

/** Every worker an owner operates (empty if they operate none). */
export async function listWorkersForOwner(ownerUserId: string): Promise<Worker[]> {
	return listWorkersForOwnerRows(ownerUserId);
}

/**
 * Resolve a raw worker credential to its `Worker` — the authentication seam
 * Phase 2's lease/heartbeat operations authenticate through. Returns `undefined`
 * for an empty or unknown credential (a not-found, not an error), mirroring
 * `resolveSession` in `./auth.ts`. The returned worker never carries the
 * credential hash.
 */
export async function resolveWorkerByCredential(
	rawCredential: string,
): Promise<Worker | undefined> {
	if (!rawCredential) return undefined;
	return findWorkerByCredentialHash(hashWorkerCredential(rawCredential));
}
