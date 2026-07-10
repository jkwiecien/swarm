import { describe, expect, it } from 'vitest';
import { parseWorkItemId, unwrap } from '@/pm/ids.js';
import type {
	CreateWorkItemInput,
	ListWorkItemsFilter,
	PMProvider,
	UpdateWorkItemPatch,
	WorkItem,
} from '@/pm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

/**
 * `src/pm/types.ts` is a type-only contract, so there's nothing to unit-test at
 * runtime directly. Instead we prove the contract is *implementable* and lock
 * its shape/behaviour with a minimal in-memory fake — if a method signature
 * drifts, this stops compiling; if the four MVP operations regress, the
 * assertions below fail. This mirrors the "executable conformance" role
 * Cascade's adapter tests play for its `PMProvider`.
 */
/**
 * Canonical pipeline status keys → provider-native option IDs, standing in for
 * the config's `statusOptions` map the real adapter resolves through. The fake
 * mirrors that split so the two vocabularies the interface documents stay
 * distinct: `filter.status` / `moveWorkItem`'s `status` are canonical keys
 * (`inProgress`, `done`), while `WorkItem.statusId` is the resolved option ID.
 */
const STATUS_OPTIONS = { inProgress: '47fc9ee4', done: '98236657' } as const;

class InMemoryPMProvider implements PMProvider {
	readonly type = 'github-projects' as const;

	private readonly items: Map<string, WorkItem>;
	private readonly statusOptions: Record<string, string>;
	private nextCommentId = 1;

	constructor(items: WorkItem[], statusOptions: Record<string, string> = {}) {
		this.items = new Map(items.map((item) => [item.id, item]));
		this.statusOptions = statusOptions;
	}

	async getWorkItem(id: string): Promise<WorkItem> {
		const item = this.items.get(id);
		if (!item) {
			throw new Error(`work item not found: ${id}`);
		}
		return item;
	}

	async listWorkItems(filter?: ListWorkItemsFilter): Promise<WorkItem[]> {
		const all = [...this.items.values()];
		if (!filter?.status) {
			return all;
		}
		// Resolve the canonical pipeline key to an option ID, as the real adapter does.
		const optionId = this.statusOptions[filter.status];
		return all.filter((item) => item.statusId === optionId);
	}

	async moveWorkItem(id: string, status: string): Promise<void> {
		const item = await this.getWorkItem(id);
		this.items.set(id, { ...item, statusId: this.statusOptions[status] });
	}

	async addComment(id: string, _text: string): Promise<string> {
		// Presence check mirrors the real adapter resolving the backing Issue/PR.
		await this.getWorkItem(id);
		return `comment-${this.nextCommentId++}`;
	}

	async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
		const id = `PVTI_new-${this.items.size + 1}`;
		const item: WorkItem = {
			id,
			title: input.title,
			description: input.description,
			url: `https://example.test/${id}`,
			statusId: this.statusOptions[input.status],
			labels: (input.labels ?? []).map((name) => ({ id: name, name })),
		};
		this.items.set(id, item);
		return item;
	}

	async updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void> {
		const item = await this.getWorkItem(id);
		this.items.set(id, {
			...item,
			...(patch.title !== undefined ? { title: patch.title } : {}),
			...(patch.description !== undefined ? { description: patch.description } : {}),
		});
	}
}

describe('PMProvider contract', () => {
	it('exposes its provider type', () => {
		const provider = new InMemoryPMProvider([]);
		expect(provider.type).toBe('github-projects');
	});

	it('getWorkItem returns the item for a known ID', async () => {
		const item = createMockWorkItem();
		const provider = new InMemoryPMProvider([item]);
		await expect(provider.getWorkItem(item.id)).resolves.toEqual(item);
	});

	it('getWorkItem throws on an unknown ID rather than returning null', async () => {
		const provider = new InMemoryPMProvider([]);
		await expect(provider.getWorkItem('PVTI_missing')).rejects.toThrow(/not found/);
	});

	it('listWorkItems returns every item when unfiltered', async () => {
		const provider = new InMemoryPMProvider([
			createMockWorkItem({ id: 'a' }),
			createMockWorkItem({ id: 'b' }),
		]);
		await expect(provider.listWorkItems()).resolves.toHaveLength(2);
	});

	it('listWorkItems filters by a canonical pipeline status key', async () => {
		const provider = new InMemoryPMProvider(
			[
				createMockWorkItem({ id: 'a', statusId: STATUS_OPTIONS.inProgress }),
				createMockWorkItem({ id: 'b', statusId: STATUS_OPTIONS.done }),
			],
			STATUS_OPTIONS,
		);
		const done = await provider.listWorkItems({ status: 'done' });
		expect(done.map((i) => i.id)).toEqual(['b']);
	});

	it('moveWorkItem resolves a canonical key to the option ID it writes', async () => {
		const item = createMockWorkItem({ statusId: STATUS_OPTIONS.inProgress });
		const provider = new InMemoryPMProvider([item], STATUS_OPTIONS);
		await provider.moveWorkItem(item.id, 'done');
		await expect(provider.getWorkItem(item.id)).resolves.toMatchObject({
			statusId: STATUS_OPTIONS.done,
		});
	});

	it('addComment returns a comment ID for a known item', async () => {
		const item = createMockWorkItem();
		const provider = new InMemoryPMProvider([item]);
		await expect(provider.addComment(item.id, 'a plan')).resolves.toBe('comment-1');
	});

	it('addComment throws on an unknown item ID rather than posting into the void', async () => {
		const provider = new InMemoryPMProvider([]);
		await expect(provider.addComment('PVTI_missing', 'a plan')).rejects.toThrow(/not found/);
	});

	it('createWorkItem adds a new item in the requested status with its labels', async () => {
		const provider = new InMemoryPMProvider([], STATUS_OPTIONS);
		const created = await provider.createWorkItem({
			title: 'Spawned task',
			description: 'Second half of the split',
			status: 'inProgress',
			labels: ['swarm:split-child'],
		});
		expect(created.statusId).toBe(STATUS_OPTIONS.inProgress);
		expect(created.labels.map((l) => l.name)).toContain('swarm:split-child');
		// It's readable back through the same board.
		await expect(provider.getWorkItem(created.id)).resolves.toMatchObject({
			title: 'Spawned task',
		});
	});

	it('updateWorkItem patches only the fields provided', async () => {
		const item = createMockWorkItem({ title: 'Old', description: 'Old body' });
		const provider = new InMemoryPMProvider([item]);
		await provider.updateWorkItem(item.id, { title: 'New' });
		await expect(provider.getWorkItem(item.id)).resolves.toMatchObject({
			title: 'New',
			description: 'Old body',
		});
	});

	it('accepts branded work-item IDs unwrapped at the boundary', async () => {
		const item = createMockWorkItem();
		const provider = new InMemoryPMProvider([item]);
		// The interface speaks plain `string`; adapters brand internally. Callers
		// holding a branded ID unwrap it at the call boundary.
		await expect(provider.getWorkItem(unwrap(parseWorkItemId(item.id)))).resolves.toEqual(item);
	});
});
