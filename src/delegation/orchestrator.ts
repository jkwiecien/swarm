/**
 * The SWARM-orchestrated delegation *child run* (docs/OPTIMIZATION.md §6
 * "Option B"), provider-neutral across every child-capable CLI.
 *
 * The primary phase agent writes a validated {@link DelegationContract} and
 * invokes `swarm delegate` (src/cli/commands/delegate.ts); this module is what
 * that command calls. It launches a lighter-model child in the *same* worktree,
 * pinned to the child model, tool-restricted, and confined — then enforces the
 * contract's `allowedPaths` against what the child actually touched (reverting
 * and rejecting anything out of scope), records the child's usage/outcome as a
 * {@link DelegationObservation}, and returns a diff report for the primary to
 * inspect and accept/rework.
 *
 * Per-CLI specifics (the child's argv/env) stay inside {@link buildChildLaunch};
 * everything else is CLI-agnostic. `git` and the child launcher are injectable
 * so the orchestration logic is unit-testable without a live CLI.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { AgentCli } from '@/harness/agent-cli.js';
import { parseAgentOutput } from '@/harness/usage.js';
import { logger } from '@/lib/logger.js';
import {
	CURATED_DOCUMENTATION_AGENT,
	DELEGATION_ENV,
	DELEGATION_REVIEW_FILENAME,
	type DelegationContract,
	type DelegationObservation,
} from './native.js';

const execFileAsync = promisify(execFile);

/** A fully-assembled child CLI invocation. */
export interface ChildLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** What a child run produced, independent of which CLI ran it. */
export interface ChildRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

/** Run one launch to completion. Injectable so tests never spawn a real CLI. */
export type ChildRunner = (
	launch: ChildLaunch,
	opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<ChildRunResult>;

/** Run a git subcommand in the worktree, resolving with its stdout. Injectable. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/**
 * A before-run snapshot of the working tree: every currently-changed path mapped
 * to its content (`null` when the path is absent). A before/after pair attributes
 * exactly what the child touched, and the `before` content is what a rejected
 * out-of-scope path is restored to — so the primary's own uncommitted edits are
 * never clobbered.
 */
export type WorktreeSnapshot = Map<string, string | null>;

/** Restore an out-of-scope path to its pre-child content (`null` → delete). Injectable. */
export type FileRestorer = (cwd: string, relPath: string, content: string | null) => void;

export interface RunDelegatedChildParams {
	contract: DelegationContract;
	cwd: string;
	/** Child CLI — the same CLI the phase runs, pinned to a lighter model. */
	cli: AgentCli;
	model: string;
	phase: string;
	minimumSemanticOperations: number;
	parentRunId?: string;
	/** Wall-clock bound (ms) for the child run. */
	timeoutMs?: number;
	signal?: AbortSignal;
	runChild?: ChildRunner;
	git?: GitRunner;
	/**
	 * Snapshot the working tree (default: git + fs). A before/after pair attributes
	 * exactly what the child touched. Injectable so the orchestration logic is
	 * unit-testable without a real worktree.
	 */
	snapshot?: (cwd: string) => Promise<WorktreeSnapshot>;
	/** Restore a reverted path's content (default: fs). Injectable for tests. */
	restoreFile?: FileRestorer;
}

export interface DelegationOutcome {
	observation: DelegationObservation;
	/** Human-readable summary + diff the `swarm delegate` command prints back. */
	report: string;
	/** Process exit code the command should use — 0 completed, 2 rejected/failed. */
	exitCode: number;
}

const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Documentation file extensions a `documentation-edit` contract may target. */
const DOCUMENTATION_EXTENSIONS = new Set(['.adoc', '.md', '.mdx', '.rst', '.txt']);
/** Worktree areas a delegation may never write, even as a documentation path. */
const PROTECTED_PREFIXES = ['.git/', '.claude/', '.agents/'];

/**
 * Validate that every `allowedPaths` entry is a documentation file inside the
 * worktree and not a protected area. Throws with a specific reason on the first
 * offending path, so the delegate command can reject before launching a child.
 */
export function validateContractPaths(contract: DelegationContract): void {
	for (const path of contract.allowedPaths) {
		const rel = normalizeRepoPath(path);
		if (rel === undefined) throw new Error(`allowedPaths entry escapes the worktree: ${path}`);
		const dot = rel.lastIndexOf('.');
		const ext = dot === -1 ? '' : rel.slice(dot).toLowerCase();
		if (!DOCUMENTATION_EXTENSIONS.has(ext)) {
			throw new Error(`allowedPaths entry is not a documentation file: ${path}`);
		}
		if (PROTECTED_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
			throw new Error(`allowedPaths entry is in a protected area: ${path}`);
		}
	}
}

/**
 * Normalize a repo-relative path, rejecting anything that escapes the worktree
 * (absolute paths, `..` traversal). Returns the cleaned forward-slash relative
 * path, or `undefined` when it escapes.
 */
function normalizeRepoPath(path: string): string | undefined {
	if (isAbsolute(path)) return undefined;
	const norm = normalize(path).replace(/\\/g, '/');
	if (norm === '..' || norm.startsWith('../')) return undefined;
	return norm.replace(/\/+$/, '');
}

async function defaultGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_CHILD_OUTPUT_BYTES });
	return stdout;
}

const defaultRunChild: ChildRunner = (launch, opts) =>
	new Promise<ChildRunResult>((resolvePromise, reject) => {
		const start = Date.now();
		const child = spawn(launch.command, launch.args, {
			cwd: opts.cwd,
			env: { ...process.env, ...launch.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let killed = false;
		const timer = opts.timeoutMs
			? setTimeout(() => {
					killed = true;
					child.kill('SIGTERM');
				}, opts.timeoutMs)
			: undefined;
		const onAbort = (): void => {
			killed = true;
			child.kill('SIGTERM');
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			if (stdout.length < MAX_CHILD_OUTPUT_BYTES) stdout += chunk;
		});
		child.stderr?.on('data', (chunk: string) => {
			if (stderr.length < MAX_CHILD_OUTPUT_BYTES) stderr += chunk;
		});
		child.on('error', (err) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			reject(new Error(`Failed to launch delegation child (${launch.command}): ${err.message}`));
		});
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			resolvePromise({
				exitCode: killed ? null : code,
				stdout,
				stderr,
				durationMs: Date.now() - start,
			});
		});
	});

/** The curated system+task prompt handed to the child, derived from the contract. */
export function buildChildPrompt(contract: DelegationContract): string {
	return [
		'You are a curated SWARM documentation editor. Apply ONLY the documentation change described',
		'below, from facts the primary agent has already decided. Edit only the exact allowed files.',
		'Do NOT reinterpret requirements, redesign behavior, broaden scope, create new files, run any',
		'command, use git, or touch anything outside the allowed files. Preserve the repository’s',
		'terminology, structure, and style. If the task is ambiguous, stop and report it rather than guess.',
		'',
		`Task: ${contract.task}`,
		'',
		'Decided facts:',
		...contract.decidedFacts.map((fact) => `- ${fact}`),
		'',
		`Allowed files (edit only these): ${contract.allowedPaths.join(', ')}`,
		`Prohibited scope: ${contract.prohibitedScope.join('; ')}`,
		`Expected artifact: ${contract.expectedArtifact}`,
		'',
		'Make the edits and stop. Do not commit, push, open a PR, or run verification — SWARM and the',
		'primary agent handle all of that after inspecting your diff.',
	].join('\n');
}

/**
 * Assemble the child CLI invocation for a given CLI, model, and worktree. This
 * is the only CLI-specific surface: Claude restricts the toolset to Read/Edit
 * (no shell → no git/commit/nested delegation); Codex runs under the
 * `workspace-write` sandbox rooted at the worktree with approvals disabled so a
 * non-interactive `exec` never blocks. Both pin the lighter child model and set
 * the recursion-guard env so the child cannot delegate again.
 */
export function buildChildLaunch(
	cli: AgentCli,
	model: string,
	cwd: string,
	contract: DelegationContract,
): ChildLaunch {
	const prompt = buildChildPrompt(contract);
	const env = { [DELEGATION_ENV.depth]: '1' };
	if (cli === 'claude') {
		return {
			command: 'claude',
			args: [
				'-p',
				'--output-format',
				'json',
				// `acceptEdits` auto-approves Read/Edit without a prompt (stdin is closed)
				// while — crucially — NOT bypassing the tool allowlist. `--dangerously-skip-permissions`
				// (== bypassPermissions) would re-enable every tool including Bash, defeating
				// the allowlist; it must not be used for a confined child.
				'--permission-mode',
				'acceptEdits',
				// Variadic list; the following `--model` flag terminates it before the
				// positional prompt, so the prompt is never swallowed as a tool name.
				'--allowedTools',
				'Read',
				'Edit',
				'--model',
				model,
				prompt,
			],
			env,
		};
	}
	if (cli === 'codex') {
		return {
			command: 'codex',
			args: [
				'exec',
				'--model',
				model,
				'--sandbox',
				'workspace-write',
				'-C',
				cwd,
				'-c',
				'approval_policy="never"',
				'--json',
				prompt,
			],
			env,
		};
	}
	// A non-child-capable CLI (antigravity) should never reach here — the policy
	// gate (`delegationEnabled`) rejects it upstream — but fail loudly rather than
	// silently launching the wrong CLI if that invariant is ever broken.
	throw new Error(`no delegation child launcher for CLI '${cli}'`);
}

/** Parse `git status --porcelain` output into the set of changed repo paths. */
function porcelainPaths(status: string): string[] {
	const paths: string[] = [];
	for (const line of status.split('\n')) {
		if (line.length < 4) continue;
		const body = line.slice(3);
		// Renames/copies print `orig -> new`; the new path is what exists on disk.
		const arrow = body.indexOf(' -> ');
		paths.push(arrow === -1 ? body : body.slice(arrow + 4));
	}
	return paths;
}

/** Read a path's content, or `null` when it is absent/unreadable. */
function readPathContent(cwd: string, rel: string): string | null {
	const abs = resolve(cwd, rel);
	if (!existsSync(abs)) return null;
	try {
		return readFileSync(abs, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Snapshot the content of every currently-changed path, so a before/after
 * comparison attributes exactly the files the child modified — even one the
 * primary had already edited (a plain path-set diff would miss a re-edit) — and
 * so a rejected out-of-scope path can be restored to its pre-child content.
 */
async function snapshotChangedPaths(git: GitRunner, cwd: string): Promise<WorktreeSnapshot> {
	const status = await git(['status', '--porcelain'], cwd);
	const snapshot: WorktreeSnapshot = new Map();
	for (const rel of porcelainPaths(status)) snapshot.set(rel, readPathContent(cwd, rel));
	return snapshot;
}

/** Paths whose content differs between two snapshots (added, changed, or removed). */
function touchedPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
	const touched: string[] = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		if ((before.get(key) ?? null) !== (after.get(key) ?? null)) touched.push(key);
	}
	return touched;
}

const defaultRestoreFile: FileRestorer = (cwd, relPath, content) => {
	const abs = resolve(cwd, relPath);
	if (content === null) {
		rmSync(abs, { force: true });
		return;
	}
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
};

/**
 * Undo the child's changes to a set of out-of-scope paths, restoring each to the
 * state the primary handed over — NOT to HEAD. A path the primary had already
 * edited is restored to that edited content (captured in `before`); a path that
 * was clean before the child is reset via HEAD (and any leftover untracked file
 * removed). This is what keeps a rejected delegation from clobbering the
 * primary's own uncommitted work. Best-effort — a revert failure is logged, never
 * thrown, so it can't mask the rejection.
 */
async function revertPaths(
	git: GitRunner,
	cwd: string,
	before: WorktreeSnapshot,
	paths: string[],
	restoreFile: FileRestorer,
): Promise<void> {
	for (const path of paths) {
		try {
			if (before.has(path)) {
				// The primary already had this path changed before delegating — restore
				// exactly that content (or its absence), never HEAD.
				restoreFile(cwd, path, before.get(path) ?? null);
			} else {
				// Clean at HEAD before the child touched it — reset to HEAD, then drop
				// any residual untracked file the child created.
				await git(['checkout', 'HEAD', '--', path], cwd).catch(() => {});
				await git(['clean', '-f', '--', path], cwd).catch(() => {});
			}
		} catch (err) {
			logger.warn('delegation: failed to revert out-of-scope path', {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/**
 * Run a curated delegation child end to end: launch it, enforce `allowedPaths`
 * against what it touched, capture its usage/outcome, and return the observation
 * plus a diff report. Never throws for an in-scope failure — a below-minimum
 * contract, a non-zero child exit, or an out-of-scope write all resolve to a
 * recorded observation with the matching outcome.
 */
export async function runDelegatedChild(
	params: RunDelegatedChildParams,
): Promise<DelegationOutcome> {
	const { contract, cwd, cli, model, phase } = params;
	const git = params.git ?? defaultGit;
	const runChild = params.runChild ?? defaultRunChild;
	const snapshot = params.snapshot ?? ((dir: string) => snapshotChangedPaths(git, dir));
	const restoreFile = params.restoreFile ?? defaultRestoreFile;
	const invocationId = randomUUID();

	const observationBase = {
		invocationId,
		contractId: contract.id,
		parentRunId: params.parentRunId || undefined,
		phase,
		agent: CURATED_DOCUMENTATION_AGENT,
		model,
		delegationType: 'documentation-edit',
		allowedPaths: contract.allowedPaths,
		reviewDisposition: 'unreported',
	} as const;

	if (contract.estimatedSemanticOperations < params.minimumSemanticOperations) {
		const reason = `delegation is below the minimum ${params.minimumSemanticOperations} semantic operations`;
		return {
			observation: { ...observationBase, outcome: 'rejected' },
			report: `Delegation rejected: ${reason}.`,
			exitCode: 2,
		};
	}

	const before = await snapshot(cwd);
	const launch = buildChildLaunch(cli, model, cwd, contract);
	const child = await runChild(launch, {
		cwd,
		timeoutMs: params.timeoutMs,
		signal: params.signal,
	});
	const after = await snapshot(cwd);

	const usage = parseAgentOutput(cli, child.stdout).usage;
	const allowed = new Set(contract.allowedPaths.map((path) => normalizeRepoPath(path)));
	const touched = touchedPaths(before, after);
	const outOfScope = touched.filter((path) => !allowed.has(normalizeRepoPath(path)));

	if (outOfScope.length > 0) {
		await revertPaths(git, cwd, before, outOfScope, restoreFile);
		const reason = `child modified files outside allowedPaths: ${outOfScope.join(', ')}`;
		return {
			observation: {
				...observationBase,
				durationMs: child.durationMs,
				usage,
				outcome: 'rejected',
			},
			report: `Delegation rejected: ${reason}. Those changes were reverted; do the work yourself or narrow the contract.`,
			exitCode: 2,
		};
	}

	if (child.exitCode !== 0) {
		return {
			observation: {
				...observationBase,
				durationMs: child.durationMs,
				usage,
				outcome: 'failed',
			},
			report: `Delegation child exited ${child.exitCode ?? 'via signal'}.\n${child.stderr.slice(0, 2000)}`,
			exitCode: 2,
		};
	}

	const diff = touched.length > 0 ? await git(['diff', '--', ...touched], cwd).catch(() => '') : '';
	const report = [
		`Delegation completed (invocationId: ${invocationId}, contractId: ${contract.id}).`,
		`Child: ${cli} (${model}), wall-clock-bounded.`,
		touched.length > 0
			? `Files changed:\n${touched.map((p) => `  ${p}`).join('\n')}`
			: 'No files changed.',
		'',
		'Inspect the diff below, then accept or rework it yourself, run verification, and record your',
		`disposition in ${DELEGATION_REVIEW_FILENAME}.`,
		'',
		diff,
	].join('\n');

	return {
		observation: {
			...observationBase,
			durationMs: child.durationMs,
			usage,
			outcome: 'completed',
		},
		report,
		exitCode: 0,
	};
}
