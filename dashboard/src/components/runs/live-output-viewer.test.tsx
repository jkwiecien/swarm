// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LiveOutputEvent, LiveOutputViewer } from './live-output-viewer.js';

const event: LiveOutputEvent = {
	id: 1,
	stream: 'stdout',
	content: 'Working…',
	emittedAt: '2026-07-16T18:00:00.000Z',
};

const viewerProps = {
	isRunning: true,
	isLoading: false,
	retentionBytes: 10_000_000,
	serverTruncated: false,
	uiTruncated: false,
};

afterEach(() => vi.restoreAllMocks());

describe('LiveOutputViewer', () => {
	it('auto-scrolls only its fixed-height output box by default', () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
			configurable: true,
			value: scrollIntoView,
		});
		const scrollHeight = vi
			.spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
			.mockReturnValue(1_000);

		render(<LiveOutputViewer events={[event]} {...viewerProps} />);

		const output = screen.getByTestId('live-output-scrollbox');
		expect(output.className).toContain('overflow-auto');
		expect(output.parentElement?.className).toContain('h-[600px]');
		expect(output.scrollTop).toBe(1_000);
		expect(scrollIntoView).not.toHaveBeenCalled();
		scrollHeight.mockRestore();
	});

	it('labels the stream as agent activity, not raw stdout', () => {
		// Claude's protocol stream is decoded into readable progress before it is
		// stored (issue #356), so "raw stdout" would misdescribe what is shown.
		render(<LiveOutputViewer events={[event]} {...viewerProps} />);

		expect(screen.getByText(/Agent activity and CLI output/)).toBeDefined();
		expect(screen.getByText('Working…')).toBeDefined();
	});

	it('lets the user disable auto-scroll', () => {
		const { rerender } = render(<LiveOutputViewer events={[event]} {...viewerProps} />);
		const output = screen.getByTestId('live-output-scrollbox');

		const toggle = screen.getByLabelText('Disable auto-scroll');
		expect(toggle.querySelector('.lucide-play')).not.toBeNull();
		fireEvent.click(toggle);
		const disabledToggle = screen.getByLabelText('Enable auto-scroll');
		expect(disabledToggle.querySelector('.lucide-pause')).not.toBeNull();

		output.scrollTop = 123;
		rerender(<LiveOutputViewer events={[event, { ...event, id: 2 }]} {...viewerProps} />);
		expect(output.scrollTop).toBe(123);
	});
});
