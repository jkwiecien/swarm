import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { Worker } from '@/identity/worker.js';
import {
	handlePostComment,
	handleSubmitReview,
	type WorkerDeliveryDeps,
} from '@/router/worker-delivery.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = 'raw-worker-credential-secret';
const RESOLVED_PAT = 'ghp-reviewer-pat-should-never-leak';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

/** A delivery provider whose metadata ops record their input and return fixed ids. */
function makeDelivery(overrides: Partial<ScmDeliveryProvider> = {}): ScmDeliveryProvider {
	return {
		commitIdentity: { name: 'reviewer', email: 'reviewer@users.noreply.github.com' },
		findPullRequest: vi.fn(),
		createPullRequest: vi.fn(),
		pushBranch: vi.fn(),
		submitReview: vi.fn().mockResolvedValue(77),
		postComment: vi.fn().mockResolvedValue(88),
		...overrides,
	};
}

function makeDeps(overrides: Partial<WorkerDeliveryDeps> = {}): WorkerDeliveryDeps {
	const project = createMockProjectConfig();
	return {
		resolveWorkerByCredential: vi.fn().mockResolvedValue(makeWorker()),
		findProjectById: vi.fn(
			async (id: string): Promise<ProjectConfig | undefined> =>
				id === project.id ? project : undefined,
		),
		isWorkerEnrolled: vi.fn().mockResolvedValue(true),
		buildScmDelivery: vi.fn().mockResolvedValue(makeDelivery()),
		...overrides,
	};
}

function reviewBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		prNumber: 42,
		verdict: 'approve',
		body: 'Looks good',
		deliveryId: 'delivery-1',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

function commentBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		prNumber: 42,
		body: 'Addressed the review',
		deliveryId: 'delivery-2',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

describe('handleSubmitReview', () => {
	beforeEach(() => vi.clearAllMocks());

	it('submits the review under the reviewer persona and returns the id', async () => {
		const submitReview = vi.fn().mockResolvedValue(77);
		const buildScmDelivery = vi.fn().mockResolvedValue(makeDelivery({ submitReview }));
		const deps = makeDeps({ buildScmDelivery });

		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ reviewId: 77 });
		expect(buildScmDelivery).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'swarm' }),
			'reviewer',
		);
		expect(submitReview).toHaveBeenCalledWith({
			prNumber: 42,
			verdict: 'approve',
			body: 'Looks good',
			deliveryId: 'delivery-1',
		});
	});

	it('rejects an unknown credential with 401 and never echoes the credential or PAT', async () => {
		const deps = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });

		const result = await handleSubmitReview(deps, 'bogus', reviewBody());

		expect(result.status).toBe(401);
		expect(result.json).toEqual({ authenticated: false });
		const serialized = JSON.stringify(result.json);
		expect(serialized).not.toContain('bogus');
		expect(serialized).not.toContain(RESOLVED_PAT);
		expect(deps.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('rejects an absent credential with 401 without resolving a worker', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(deps, undefined, reviewBody());
		expect(result.status).toBe(401);
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('returns 404 for an unknown project', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody({ projectId: 'nope' }));
		expect(result.status).toBe(404);
		expect(deps.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('returns 403 when the worker is not enrolled in the project', async () => {
		const deps = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody());
		expect(result.status).toBe(403);
		expect(deps.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody({ verdict: 'lgtm' }));
		expect(result.status).toBe(400);
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('returns 400 for a protocol-version mismatch', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(
			deps,
			CREDENTIAL,
			reviewBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
		);
		expect(result.status).toBe(400);
		expect(result.json).toMatchObject({ protocolVersion: TRANSPORT_PROTOCOL_VERSION });
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});
});

describe('handlePostComment', () => {
	beforeEach(() => vi.clearAllMocks());

	it('posts the comment and returns the id', async () => {
		const postComment = vi.fn().mockResolvedValue(88);
		const deps = makeDeps({
			buildScmDelivery: vi.fn().mockResolvedValue(makeDelivery({ postComment })),
		});

		const result = await handlePostComment(deps, CREDENTIAL, commentBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ commentId: 88 });
		expect(postComment).toHaveBeenCalledWith({
			prNumber: 42,
			body: 'Addressed the review',
			deliveryId: 'delivery-2',
		});
	});

	it('enforces auth and enrollment before touching the PAT', async () => {
		const unknown = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		expect((await handlePostComment(unknown, 'bogus', commentBody())).status).toBe(401);

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handlePostComment(unenrolled, CREDENTIAL, commentBody())).status).toBe(403);
		expect(unenrolled.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body', async () => {
		const deps = makeDeps();
		const result = await handlePostComment(deps, CREDENTIAL, commentBody({ body: '' }));
		expect(result.status).toBe(400);
	});
});

describe('control-plane delivery seam', () => {
	beforeEach(() => vi.clearAllMocks());

	it('carries only the review metadata to the reviewer PAT and round-trips the id', async () => {
		// A `buildScmDelivery` standing in for the server-side reviewer-PAT write:
		// it asserts exactly the verdict + body reached it (proving only metadata
		// crossed, never a repository tree) and returns a review id.
		const submitReview = vi.fn(
			async (input: { prNumber: number; verdict: string; body: string; deliveryId: string }) => {
				expect(input).toEqual({
					prNumber: 42,
					verdict: 'request-changes',
					body: 'Please fix the null check',
					deliveryId: 'delivery-9',
				});
				return 4242;
			},
		);
		const deps = makeDeps({
			buildScmDelivery: vi.fn().mockResolvedValue(makeDelivery({ submitReview })),
		});

		const result = await handleSubmitReview(
			deps,
			CREDENTIAL,
			reviewBody({
				verdict: 'request-changes',
				body: 'Please fix the null check',
				deliveryId: 'delivery-9',
			}),
		);

		expect(result.json).toEqual({ reviewId: 4242 });
	});
});
