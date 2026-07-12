import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

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
});
export type DeliveryProgress = z.infer<typeof DeliveryProgressSchema>;

export interface CreatePullRequestInput {
	baseBranch: string;
	branch: string;
	title: string;
	body: string;
}

export interface ScmDeliveryProvider {
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
	if (!existsSync(path)) return { deliveryId, pushed: false };
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

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd });
	return stdout.trim();
}

export async function validatePreparedTree(cwd: string): Promise<void> {
	const unresolved = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
	if (unresolved) throw new Error(`Unsafe delivery: unresolved conflicts in ${unresolved}`);
	const status = await git(cwd, ['status', '--porcelain']);
	if (!status) throw new Error('Unsafe delivery: expected working-tree changes but found none');
	const scratch = status
		.split('\n')
		.map((line) => line.slice(3))
		.filter(
			(path) =>
				Object.values(HANDOFF_FILENAMES).includes(path as never) || path === PROGRESS_FILENAME,
		);
	if (scratch.some((path) => !status.includes(`?? ${path}`))) {
		throw new Error(`Unsafe delivery: scratch artifact is tracked (${scratch.join(', ')})`);
	}
}

export async function commitPreparedTree(cwd: string, subject: string): Promise<string> {
	await validatePreparedTree(cwd);
	await git(cwd, [
		'add',
		'--all',
		'--',
		'.',
		...Object.values(HANDOFF_FILENAMES).flatMap((name) => [`:(exclude)${name}`]),
		`:(exclude)${PROGRESS_FILENAME}`,
	]);
	const staged = await git(cwd, ['diff', '--cached', '--name-only']);
	if (!staged)
		throw new Error(
			'Unsafe delivery: no deliverable changes remain after excluding hand-off artifacts',
		);
	await git(cwd, ['commit', '-m', subject]);
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
