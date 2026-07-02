import { describe, expect, it } from 'vitest';
import { parseWorkItemId, unwrap } from '@/pm/ids.js';
import type { ListWorkItemsFilter, PMProvider, WorkItem } from '@/pm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

/**
 * `src/pm/types.ts` is a type-only contract, so there's nothing to unit-test at
 * runtime directly. Instead we prove the contract is *implementable* and lock
 * its shape/behaviour with a minimal in-memory fake — if a method signature
 * drifts, this stops compiling; if the four MVP operations regress, the
 * assertions below fail. This mirrors the "executable conformance" role
 * Cascade's adapter tests play for its `PMProvider`.
 */
class InMemoryPMProvider implements PMProvider {
	readonly type = 'github-projects' as const;

	private readonly items: Map<string, WorkItem>;
	private nextCommentId = 1;

	constructor(items: WorkItem[]) {
		this.items = new Map(items.map((item) => [item.id, item]));
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
		return all.filter((item) => item.statusId === filter.status);
	}

	async moveWorkItem(id: string, status: string): Promise<void> {
		const item = await this.getWorkItem(id);
		this.items.set(id, { ...item, statusId: status });
	}

	async addComment(id: string, _text: string): Promise<string> {
		// Presence check mirrors the real adapter resolving the backing Issue/PR.
		await this.getWorkItem(id);
		return `comment-${this.nextCommentId++}`;
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

	it('listWorkItems filters by status', async () => {
		const provider = new InMemoryPMProvider([
			createMockWorkItem({ id: 'a', statusId: '47fc9ee4' }),
			createMockWorkItem({ id: 'b', statusId: '98236657' }),
		]);
		const done = await provider.listWorkItems({ status: '98236657' });
		expect(done.map((i) => i.id)).toEqual(['b']);
	});

	it('moveWorkItem updates the item status', async () => {
		const item = createMockWorkItem({ statusId: '47fc9ee4' });
		const provider = new InMemoryPMProvider([item]);
		await provider.moveWorkItem(item.id, '98236657');
		await expect(provider.getWorkItem(item.id)).resolves.toMatchObject({ statusId: '98236657' });
	});

	it('addComment returns a comment ID for a known item', async () => {
		const item = createMockWorkItem();
		const provider = new InMemoryPMProvider([item]);
		await expect(provider.addComment(item.id, 'a plan')).resolves.toBe('comment-1');
	});

	it('accepts branded work-item IDs unwrapped at the boundary', async () => {
		const item = createMockWorkItem();
		const provider = new InMemoryPMProvider([item]);
		// The interface speaks plain `string`; adapters brand internally. Callers
		// holding a branded ID unwrap it at the call boundary.
		await expect(provider.getWorkItem(unwrap(parseWorkItemId(item.id)))).resolves.toEqual(item);
	});
});
