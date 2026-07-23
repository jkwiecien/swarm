export type WorkItemKind = 'issue' | 'pr';

export interface WorkItemRef {
	kind: WorkItemKind;
	number: string;
}

export function parseWorkItemRef(url: string | null | undefined): WorkItemRef | null {
	if (!url) return null;
	const match = url.match(/\/(issues|pull)\/(\d+)(?:[/?#]|$)/);
	if (!match) return null;
	return {
		kind: match[1] === 'pull' ? 'pr' : 'issue',
		number: match[2],
	};
}

export function workItemLabel(ref: WorkItemRef): string {
	return `${ref.kind === 'pr' ? 'PR' : 'Issue'}: #${ref.number}`;
}
