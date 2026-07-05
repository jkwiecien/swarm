/**
 * Repo-root resolution for the `swarm` operator CLI.
 *
 * The CLI shells out to `docker compose` and reads/writes `.env` — both of which
 * must be anchored to the repo root, not the caller's cwd. Resolving it from
 * this module's own location (rather than `process.cwd()`) means `swarm status`
 * works from any directory, including a task worktree. `src/cli/_shared/` and
 * its compiled twin `dist/cli/_shared/` sit at the same depth, so the same
 * `../../..` walk lands on the root whether run via tsx or from `dist/`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
