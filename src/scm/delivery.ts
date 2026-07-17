import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
	DELEGATION_EVENTS_FILENAME,
	DELEGATION_REVIEW_FILENAME,
	DELEGATION_SCRATCH_GLOB,
} from '../delegation/native.js';
import type { AgentCli, AgentCliResult } from '../harness/agent-cli.js';

const execFileAsync = promisify(execFile);

// Git exports repository-local variables while running hooks. They override
// `cwd`, so carrying them into a worktree delivery can redirect commands to
// the hook's repository/index. Preserve transport/auth variables, but always
// let the requested worktree determine repository location.
const repositoryLocalGitEnvironment = [
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_CONFIG',
	'GIT_CONFIG_PARAMETERS',
	'GIT_OBJECT_DIRECTORY',
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_IMPLICIT_WORK_TREE',
	'GIT_GRAFT_FILE',
	'GIT_INDEX_FILE',
	'GIT_NO_REPLACE_OBJECTS',
	'GIT_REPLACE_REF_BASE',
	'GIT_PREFIX',
	'GIT_INTERNAL_SUPER_PREFIX',
	'GIT_SHALLOW_FILE',
	'GIT_COMMON_DIR',
] as const;

function gitEnvironmentForCwd(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of repositoryLocalGitEnvironment) delete env[key];
	return env;
}

export const VerificationSchema = z.object({
	command: z.string().min(1),
	outcome: z.literal('passed'),
});

const CommitSchema = z.object({
	commitSubject: z.string().min(1).max(200),
	verification: z.array(VerificationSchema).min(1),
});

export const ImplementationHandoffSchema = CommitSchema.extend({
	summary: z.string().min(1),
	limitations: z.array(z.string()).default([]),
	readyForDelivery: z.literal(true),
});

export const ReviewHandoffSchema = z.object({
	verdict: z.enum(['approve', 'request-changes', 'comment']),
	body: z.string().min(1),
	findings: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
});

export const ReviewResponseHandoffSchema = z.object({
	outcome: z.enum(['fixed', 'pushed-back', 'no-findings']),
	body: z.string().min(1),
	commitSubject: z.string().min(1).max(200).optional(),
	verification: z.array(VerificationSchema).default([]),
});

export const CiResponseHandoffSchema = z.object({
	outcome: z.enum(['fixed', 'no-fix']),
	body: z.string().min(1),
	commitSubject: z.string().min(1).max(200).optional(),
	verification: z.array(VerificationSchema).default([]),
});

export const ConflictHandoffSchema = z.object({
	status: z.literal('resolved'),
	body: z.string().min(1),
	verification: z.array(VerificationSchema).min(1),
});

export const DeliveryProgressSchema = z.object({
	deliveryId: z.string(),
	commitSha: z.string().optional(),
	pushed: z.boolean().default(false),
	pullRequestNumber: z.number().int().positive().optional(),
	pullRequestUrl: z.string().url().optional(),
	reviewId: z.number().int().positive().optional(),
	commentId: z.number().int().positive().optional(),
	/**
	 * Whether the follow-up Review for a `fixed` Respond-to-review response has
	 * already been enqueued (issue #241) — checked before
	 * {@link ScheduleFollowUpReview} runs so a resumed delivery retry doesn't
	 * re-enqueue once the checkpoint is saved (the queue's own deterministic job
	 * id already absorbs a repeat in the narrower crash window before this is
	 * written).
	 */
	followUpEnqueued: z.boolean().default(false),
});
export type DeliveryProgress = z.infer<typeof DeliveryProgressSchema>;

export interface CreatePullRequestInput {
	baseBranch: string;
	branch: string;
	title: string;
	body: string;
}

export interface ScmDeliveryProvider {
	commitIdentity: { name: string; email: string };
	findPullRequest(branch: string): Promise<{ number: number; url: string } | undefined>;
	createPullRequest(input: CreatePullRequestInput): Promise<{ number: number; url: string }>;
	pushBranch(cwd: string, branch: string, expectedSha: string): Promise<void>;
	submitReview(input: {
		prNumber: number;
		verdict: z.infer<typeof ReviewHandoffSchema>['verdict'];
		body: string;
		deliveryId: string;
	}): Promise<number>;
	postComment(input: { prNumber: number; body: string; deliveryId: string }): Promise<number>;
}

export const HANDOFF_FILENAMES = {
	implementation: 'implementation_handoff.json',
	review: 'review_handoff.json',
	respondToReview: 'respond_to_review_handoff.json',
	respondToCi: 'respond_to_ci_handoff.json',
	resolveConflicts: 'resolve_conflicts_handoff.json',
} as const;

const PROGRESS_FILENAME = '.swarm_delivery.json';
const SCRATCH_PATHSPECS = [
	...Object.values(HANDOFF_FILENAMES),
	PROGRESS_FILENAME,
	DELEGATION_EVENTS_FILENAME,
	DELEGATION_REVIEW_FILENAME,
	// Covers the events log, the review file, and per-delegation contract manifests
	// (`.swarm-delegation-<id>.contract.json`) so delegation scratch never lands in a PR.
	`:(glob)${DELEGATION_SCRATCH_GLOB}`,
] as const;

export class DeliveryDeferredError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'DeliveryDeferredError';
	}
}

export function resumedDeliveryAgent(cli: AgentCli): AgentCliResult {
	return {
		cli,
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 0,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

export function readHandoff<T>(cwd: string, filename: string, schema: z.ZodType<T>): T {
	const path = join(cwd, filename);
	if (!existsSync(path)) throw new Error(`Agent did not write required hand-off ${filename}`);
	try {
		return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
	} catch (error) {
		throw new Error(
			`Invalid hand-off ${filename}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function deliveryIdentity(parts: readonly string[]): string {
	return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

export function loadDeliveryProgress(cwd: string, deliveryId: string): DeliveryProgress {
	const path = join(cwd, PROGRESS_FILENAME);
	if (!existsSync(path)) return { deliveryId, pushed: false, followUpEnqueued: false };
	const progress = DeliveryProgressSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (progress.deliveryId !== deliveryId)
		throw new Error('Delivery progress belongs to another operation');
	return progress;
}

export function saveDeliveryProgress(cwd: string, progress: DeliveryProgress): void {
	writeFileSync(join(cwd, PROGRESS_FILENAME), `${JSON.stringify(progress, null, 2)}\n`, {
		mode: 0o600,
	});
}

export function hasDeliveryProgress(cwd: string): boolean {
	return existsSync(join(cwd, PROGRESS_FILENAME));
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnvironmentForCwd() });
	return stdout.trim();
}

export async function validatePreparedTree(cwd: string): Promise<void> {
	const unresolved = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
	if (unresolved) throw new Error(`Unsafe delivery: unresolved conflicts in ${unresolved}`);
	const status = await git(cwd, ['status', '--porcelain']);
	if (!status) throw new Error('Unsafe delivery: expected working-tree changes but found none');
	const trackedScratch = await git(cwd, ['ls-files', '--', ...SCRATCH_PATHSPECS]);
	if (trackedScratch)
		throw new Error(`Unsafe delivery: scratch artifact is tracked (${trackedScratch})`);
}

export async function commitPreparedTree(
	cwd: string,
	subject: string,
	identity: { name: string; email: string },
): Promise<string> {
	await validatePreparedTree(cwd);
	await git(cwd, [
		'add',
		'--all',
		'--',
		'.',
		...SCRATCH_PATHSPECS.map((path) =>
			path.startsWith(':(glob)')
				? `:(exclude,glob)${path.slice(':(glob)'.length)}`
				: `:(exclude)${path}`,
		),
	]);
	const staged = await git(cwd, ['diff', '--cached', '--name-only']);
	if (!staged)
		throw new Error(
			'Unsafe delivery: no deliverable changes remain after excluding hand-off artifacts',
		);
	await git(cwd, [
		'-c',
		`user.name=${identity.name}`,
		'-c',
		`user.email=${identity.email}`,
		'commit',
		'-m',
		subject,
	]);
	return git(cwd, ['rev-parse', 'HEAD']);
}

export async function assertRemoteHead(
	cwd: string,
	branch: string,
	expectedSha: string,
): Promise<void> {
	await git(cwd, ['fetch', 'origin', branch]);
	const remote = await git(cwd, ['rev-parse', `origin/${branch}`]);
	if (remote !== expectedSha)
		throw new Error(`Remote head drift for ${branch}: expected ${expectedSha}, found ${remote}`);
}
