import { describe, expect, it } from 'vitest';
import { QUEUE_NAME, SwarmJobSchema } from '@/queue/jobs.js';
import {
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
} from '../../helpers/factories.js';

// Jobs cross the router→Redis→worker boundary as JSON, so every case parses a
// JSON round-trip of the fixture — what the consumer actually receives.
function roundTrip(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

describe('SwarmJobSchema', () => {
	it('parses a github webhook job', () => {
		const job = createMockGitHubWebhookJob();
		expect(SwarmJobSchema.parse(roundTrip(job))).toEqual(job);
	});

	it('parses a github-projects webhook job', () => {
		const job = createMockGitHubProjectsWebhookJob();
		expect(SwarmJobSchema.parse(roundTrip(job))).toEqual(job);
	});

	it('parses a job without the optional deliveryId', () => {
		const { deliveryId: _dropped, ...job } = createMockGitHubWebhookJob();
		const parsed = SwarmJobSchema.parse(roundTrip(job));
		expect(parsed.deliveryId).toBeUndefined();
	});

	it('rejects an unknown job type', () => {
		const job = { ...createMockGitHubWebhookJob(), type: 'gitlab' };
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects an empty projectId', () => {
		const job = { ...createMockGitHubWebhookJob(), projectId: '' };
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects a github job carrying a projects_v2_item event', () => {
		const job = {
			...createMockGitHubWebhookJob(),
			event: createMockGitHubProjectsWebhookJob().event,
		};
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects an SCM event type outside PROCESSABLE_EVENTS', () => {
		const job = createMockGitHubWebhookJob();
		const tampered = { ...job, event: { ...job.event, eventType: 'push' } };
		expect(() => SwarmJobSchema.parse(roundTrip(tampered))).toThrow();
	});

	it('names the queue both sides speak on', () => {
		expect(QUEUE_NAME).toBe('swarm-jobs');
	});
});
