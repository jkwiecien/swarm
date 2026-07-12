/**
 * Antigravity session capture — the out-of-band half of "resume an `agy` run".
 *
 * Unlike `claude` (which lets SWARM *assign* a session UUID via `--session-id`)
 * and `codex` (which emits its `thread_id` on stdout as a `thread.started`
 * event), `agy --print` neither accepts an id to assign nor prints the
 * conversation id anywhere — its stdout is just the answer, and the conversation
 * `.db` it writes doesn't embed the working directory (both verified live). So
 * the only way to learn the id a run created is to watch its on-disk
 * conversation store: snapshot the set of conversation files *before* the run,
 * then diff *after* it, and the new file's basename is this run's conversation
 * id — the value `agy --conversation <id>` takes to resume it (ai/RULES.md §6:
 * each CLI's resume mechanism differs; the harness owns these quirks).
 *
 * This is best-effort: if the store is missing, unreadable, or the diff is
 * ambiguous, capture returns `undefined` and the run simply isn't resumable —
 * the caller falls back to a from-scratch retry, never a failure.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';

/**
 * Where `agy` stores one SQLite file per conversation, `<conversation-id>.db`
 * (plus transient `-wal`/`-shm` companions). Overridable via
 * `SWARM_ANTIGRAVITY_CONVERSATIONS_DIR` for tests and non-default installs;
 * defaults to the observed live location.
 */
export function conversationsDir(): string {
	return (
		process.env.SWARM_ANTIGRAVITY_CONVERSATIONS_DIR ||
		path.join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
	);
}

/** Map a directory entry to its conversation id, or undefined if it isn't one. */
function conversationIdFromEntry(entry: string): string | undefined {
	// Only the primary `.db` file names the conversation; `.db-wal` / `.db-shm`
	// are transient SQLite companions for the same id and must not be counted as
	// separate conversations.
	return entry.endsWith('.db') ? entry.slice(0, -'.db'.length) : undefined;
}

/**
 * Snapshot the conversation ids present before a run starts. Returns an empty
 * set when the store doesn't exist yet (a first-ever `agy` run creates it) or
 * can't be read — the after-diff then simply attributes any new file to this run.
 *
 * Synchronous on purpose: it runs immediately before `spawn` in the harness, and
 * a sync read keeps the spawn on the same tick (no observable delay to the run,
 * and the harness's "spawn happens synchronously" contract holds). The store is
 * a small local directory, so the read is cheap.
 */
export function snapshotConversationIds(dir = conversationsDir()): Set<string> {
	try {
		const ids = new Set<string>();
		for (const entry of readdirSync(dir)) {
			const id = conversationIdFromEntry(entry);
			if (id) ids.add(id);
		}
		return ids;
	} catch {
		return new Set<string>();
	}
}

/**
 * Diff the conversation store against a {@link snapshotConversationIds} taken
 * before the run, returning the id of the conversation this run created. Exactly
 * one new id is the normal case. If several appeared (a concurrent `agy` run
 * finished in the same window), the newest `.db` by modification time is this
 * run's — its file was written last, at this run's close. Returns `undefined`
 * when nothing new appeared or the store can't be read (run not resumable).
 */
export function detectNewConversationId(
	before: Set<string>,
	dir = conversationsDir(),
): string | undefined {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined;
	}
	const fresh: string[] = [];
	for (const entry of entries) {
		const id = conversationIdFromEntry(entry);
		if (id && !before.has(id)) fresh.push(id);
	}
	if (fresh.length === 0) return undefined;
	if (fresh.length === 1) return fresh[0];

	// Ambiguous: pick the most-recently-written `.db`. Under SWARM's default
	// single worker this branch is never hit; it only matters at
	// SWARM_WORKER_CONCURRENCY > 1, where mtime disambiguates.
	logger.debug('antigravity-session: multiple new conversations, disambiguating by mtime', {
		count: fresh.length,
	});
	let newestId: string | undefined;
	let newestMs = Number.NEGATIVE_INFINITY;
	for (const id of fresh) {
		try {
			const { mtimeMs } = statSync(path.join(dir, `${id}.db`));
			if (mtimeMs > newestMs) {
				newestMs = mtimeMs;
				newestId = id;
			}
		} catch {
			// Ignore an id whose file vanished between readdir and stat.
		}
	}
	return newestId;
}
