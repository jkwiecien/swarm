/** Shared widths for the first three columns of the queued and persisted run tables. */
export function runTableColumnWidths(showProject: boolean): {
	phase: string;
	project: string;
	task: string;
} {
	return showProject
		? { phase: 'w-[12%]', project: 'w-[14%]', task: 'w-[24%]' }
		: { phase: 'w-[18%]', project: 'w-0', task: 'w-[32%]' };
}
