/** Shared widths for the queued and persisted run tables. */
export function runTableColumnWidths(showProject: boolean): {
	phase: string;
	project: string;
	task: string;
	status: string;
	started: string;
	duration: string;
	model: string;
	tokens: string;
} {
	return showProject
		? {
				phase: 'w-[12%]',
				project: 'w-[8%]',
				task: 'w-[32%]',
				status: 'w-[12%]',
				started: 'w-[8%]',
				duration: 'w-[7%]',
				model: 'w-[12%]',
				tokens: 'w-[9%]',
			}
		: {
				phase: 'w-[12%]',
				project: 'w-0',
				task: 'w-[40%]',
				status: 'w-[12%]',
				started: 'w-[8%]',
				duration: 'w-[7%]',
				model: 'w-[12%]',
				tokens: 'w-[9%]',
			};
}
