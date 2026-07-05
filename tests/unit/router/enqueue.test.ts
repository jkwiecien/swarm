import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockGitHubParsedEvent,
	createMockGitHubProjectsParsedEvent,
	createMockProjectConfig,
} from '../../helpers/factories.js';

// The seam's only job is to shape the event into a SwarmJob and hand it to the
// producer — mock the producer and assert the job it's handed.
const { enqueueJob } = vi.hoisted(() => ({ enqueueJob: vi.fn() }));
vi.mock('@/queue/producer.js', () => ({ enqueueJob }));

import { enqueueProjectsEvent, enqueueWebhookEvent } from '@/router/enqueue.js';

beforeEach(() => {
	enqueueJob.mockReset();
	enqueueJob.mockResolvedValue('bull-job-id');
});

describe('enqueueWebhookEvent', () => {
	it('enqueues a github-typed job carrying the event, project id, and deliveryId', async () => {
		const event = createMockGitHubParsedEvent();
		const project = createMockProjectConfig({ id: 'acme' });

		await enqueueWebhookEvent(event, project, 'delivery-1');

		expect(enqueueJob).toHaveBeenCalledWith({
			type: 'github',
			projectId: 'acme',
			deliveryId: 'delivery-1',
			event,
		});
	});

	it('passes deliveryId through as undefined when absent', async () => {
		const event = createMockGitHubParsedEvent();
		const project = createMockProjectConfig();

		await enqueueWebhookEvent(event, project, undefined);

		expect(enqueueJob).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'github', deliveryId: undefined }),
		);
	});
});

describe('enqueueProjectsEvent', () => {
	it('enqueues a github-projects-typed job carrying the event, project id, and deliveryId', async () => {
		const event = createMockGitHubProjectsParsedEvent();
		const project = createMockProjectConfig({ id: 'acme' });

		await enqueueProjectsEvent(event, project, 'delivery-2');

		expect(enqueueJob).toHaveBeenCalledWith({
			type: 'github-projects',
			projectId: 'acme',
			deliveryId: 'delivery-2',
			event,
		});
	});
});
