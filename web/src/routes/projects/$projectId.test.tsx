// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../../src/config/schema.js';
import {
	PhaseConfigRow,
	PhaseEnabledCell,
	PhaseSettingsDetail,
	PhaseToggleSwitch,
	PipelineSettingsForm,
} from './$projectId.js';

describe('PhaseToggleSwitch', () => {
	it('renders as a switch with the correct accessible label and state', () => {
		render(
			<PhaseToggleSwitch checked={true} label="Test label" disabled={false} onChange={() => {}} />,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement).toBeDefined();
		expect(switchElement.getAttribute('aria-checked')).toBe('true');
		expect(switchElement.getAttribute('aria-label')).toBe('Test label');
		expect(switchElement.disabled).toBe(false);
	});

	it('respects the disabled prop', () => {
		render(
			<PhaseToggleSwitch checked={false} label="Test label" disabled={true} onChange={() => {}} />,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement.disabled).toBe(true);
		expect(switchElement.getAttribute('aria-checked')).toBe('false');
	});

	it('triggers onChange and stops propagation when clicked', () => {
		const handleChange = vi.fn();

		render(
			<PhaseToggleSwitch
				checked={false}
				label="Test label"
				disabled={false}
				onChange={handleChange}
			/>,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		const event = new MouseEvent('click', { bubbles: true, cancelable: true });
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

		fireEvent(switchElement, event);

		expect(handleChange).toHaveBeenCalledTimes(1);
		expect(stopPropagationSpy).toHaveBeenCalledTimes(1);
	});
});

describe('PhaseEnabledCell', () => {
	it('renders "Always on" text for mandatory phases when enabled is undefined', () => {
		render(
			<PhaseEnabledCell phase="planning" label="Planning" enabled={undefined} isPending={false} />,
		);

		expect(screen.getByText('Always on')).toBeDefined();
		expect(screen.queryByRole('switch')).toBeNull();
	});

	it('renders an interactive toggle switch for optional phases when enabled is defined', () => {
		const handleChange = vi.fn();
		render(
			<PhaseEnabledCell
				phase="review"
				label="Review"
				enabled={true}
				isPending={false}
				handleEnabledChange={handleChange}
			/>,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement).toBeDefined();
		expect(switchElement.getAttribute('aria-checked')).toBe('true');

		fireEvent.click(switchElement);
		expect(handleChange).toHaveBeenCalledWith('review', false);
	});

	it('renders a disabled toggle switch when enabledDisabled is true', () => {
		render(
			<PhaseEnabledCell
				phase="respondToReview"
				label="Respond to Review"
				enabled={true}
				enabledDisabled={true}
				isPending={false}
			/>,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement.disabled).toBe(true);
	});
});

describe('PhaseConfigRow', () => {
	const mockConfig: AgentConfig = {
		cli: 'claude',
		model: 'claude-3-5-sonnet',
		timeoutMs: 30 * 60 * 1000,
	};

	it('renders Planning row with auto-advance toggle', () => {
		const handleAutoAdvanceChange = vi.fn();
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="planning"
						config={mockConfig}
						isPending={false}
						enabled={undefined}
						autoAdvance={true}
						handleAutoAdvanceChange={handleAutoAdvanceChange}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Planning')).toBeDefined();
		expect(screen.getByText('Always on')).toBeDefined();

		// Auto-advance toggle should exist
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(1);
		expect(switches[0].getAttribute('aria-label')).toBe('Planning auto-advance');
		expect(switches[0].getAttribute('aria-checked')).toBe('true');

		// Click the auto-advance toggle
		fireEvent.click(switches[0]);
		expect(handleAutoAdvanceChange).toHaveBeenCalledWith('planning', false);
	});

	it('renders Review row with auto-advance as N/A', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="review"
						config={mockConfig}
						isPending={false}
						enabled={true}
						autoAdvance={undefined}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Review')).toBeDefined();
		expect(screen.getByText('N/A')).toBeDefined();

		// The only switch should be the Enabled cell switch
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(1);
		expect(switches[0].getAttribute('aria-label')).toBe('Review enabled');
	});

	it('renders Implementation (unplanned) auto-advance as an alias of Implementation', () => {
		const handleAutoAdvanceChange = vi.fn();
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="implementationUnplanned"
						config={mockConfig}
						isPending={false}
						enabled={undefined}
						autoAdvance={true}
						handleAutoAdvanceChange={handleAutoAdvanceChange}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Implementation (unplanned)')).toBeDefined();
		expect(screen.getByText('implementationUnplanned')).toBeDefined();
		expect(screen.getByText('Always on')).toBeDefined();
		const autoAdvanceSwitch = screen.getByLabelText(
			'Implementation (unplanned) auto-advance',
		) as HTMLButtonElement;
		expect(autoAdvanceSwitch.getAttribute('aria-checked')).toBe('true');
		fireEvent.click(autoAdvanceSwitch);
		expect(handleAutoAdvanceChange).toHaveBeenCalledWith('implementation', false);
	});

	it('calls onSelect when clicking the row itself, but not when clicking the toggle', () => {
		const handleSelect = vi.fn();
		const handleEnabledChange = vi.fn();

		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="review"
						config={mockConfig}
						isPending={false}
						enabled={true}
						handleEnabledChange={handleEnabledChange}
						onSelect={handleSelect}
					/>
				</tbody>
			</table>,
		);

		// Click the toggle switch
		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		fireEvent.click(switchElement);
		expect(handleEnabledChange).toHaveBeenCalledTimes(1);
		expect(handleSelect).not.toHaveBeenCalled();

		// Click the row/text
		fireEvent.click(screen.getByText('Review'));
		expect(handleSelect).toHaveBeenCalledTimes(1);
	});
});

describe('PhaseSettingsDetail', () => {
	const mockConfig: AgentConfig = {
		cli: 'claude',
		model: 'claude-3-5-sonnet',
		timeoutMs: 30 * 60 * 1000,
		prompt: 'Custom test instructions',
	};

	it('renders with Enabled toggle aligned with the current state', () => {
		const handleEnabledChange = vi.fn();
		render(
			<PhaseSettingsDetail
				phase="review"
				config={mockConfig}
				isPending={false}
				enabled={true}
				handleEnabledChange={handleEnabledChange}
				handleCliChange={() => {}}
				handleModelChange={() => {}}
				handleReasoningChange={() => {}}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		// Check title
		expect(screen.getByRole('heading', { level: 2, name: 'Review' })).toBeDefined();

		// Should have Enabled switch showing checked=true
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(1);
		expect(switches[0].getAttribute('aria-label')).toBe('Review enabled');
		expect(switches[0].getAttribute('aria-checked')).toBe('true');

		// Toggle enabled
		fireEvent.click(switches[0]);
		expect(handleEnabledChange).toHaveBeenCalledWith('review', false);
	});

	it('renders with always-on disabled switch for mandatory phases', () => {
		render(
			<PhaseSettingsDetail
				phase="planning"
				config={mockConfig}
				isPending={false}
				enabled={undefined}
				handleCliChange={() => {}}
				handleModelChange={() => {}}
				handleReasoningChange={() => {}}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement.disabled).toBe(true);
		expect(switchElement.getAttribute('aria-checked')).toBe('true');
		expect(screen.getByText('Enabled')).toBeDefined();
		expect(screen.getByText('Always on')).toBeDefined();
	});

	it('renders the shared auto-advance switch and explanatory note for Implementation (unplanned)', () => {
		const handleAutoAdvanceChange = vi.fn();
		render(
			<PhaseSettingsDetail
				phase="implementationUnplanned"
				config={mockConfig}
				isPending={false}
				enabled={undefined}
				autoAdvance={true}
				handleAutoAdvanceChange={handleAutoAdvanceChange}
				handleCliChange={() => {}}
				handleModelChange={() => {}}
				handleReasoningChange={() => {}}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		expect(
			screen.getByRole('heading', { level: 2, name: 'Implementation (unplanned)' }),
		).toBeDefined();

		// The phase is always on and mirrors Implementation's auto-advance setting.
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(2);
		expect(switches[0].disabled).toBe(true);
		expect(switches[0].getAttribute('aria-checked')).toBe('true');
		fireEvent.click(screen.getByLabelText('Implementation (unplanned) auto-advance'));
		expect(handleAutoAdvanceChange).toHaveBeenCalledWith('implementation', false);
		expect(screen.getByText('Always on')).toBeDefined();

		expect(
			screen.getByText(/Used only when Implementation was not preceded by a Planning run/),
		).toBeDefined();
	});

	it('renders Auto-advance toggle switch when autoAdvance is defined', () => {
		const handleAutoAdvanceChange = vi.fn();
		render(
			<PhaseSettingsDetail
				phase="planning"
				config={mockConfig}
				isPending={false}
				enabled={undefined}
				autoAdvance={true}
				handleAutoAdvanceChange={handleAutoAdvanceChange}
				handleCliChange={() => {}}
				handleModelChange={() => {}}
				handleReasoningChange={() => {}}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		// Should have auto-advance switch
		const autoAdvanceSwitch = screen.getByLabelText('Planning auto-advance') as HTMLButtonElement;
		expect(autoAdvanceSwitch).toBeDefined();
		expect(autoAdvanceSwitch.getAttribute('aria-checked')).toBe('true');

		fireEvent.click(autoAdvanceSwitch);
		expect(handleAutoAdvanceChange).toHaveBeenCalledWith('planning', false);
	});

	it('renders locked state label for respondToReview when enabledDisabled is true', () => {
		render(
			<PhaseSettingsDetail
				phase="respondToReview"
				config={mockConfig}
				isPending={false}
				enabled={true}
				enabledDisabled={true}
				handleCliChange={() => {}}
				handleModelChange={() => {}}
				handleReasoningChange={() => {}}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		expect(screen.getByText('Enabled')).toBeDefined();
		expect(screen.getByText('Locked off while Review is disabled.')).toBeDefined();
	});
});

describe('PipelineSettingsForm — Review check policy', () => {
	const noop = () => {};

	it('defaults to Require CI checks selected', () => {
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="required"
				setReviewChecksPolicy={noop}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		const required = screen.getByRole('radio', {
			name: /^Require CI checks/,
		}) as HTMLInputElement;
		const ifPresent = screen.getByRole('radio', {
			name: /^Review when no checks exist/,
		}) as HTMLInputElement;
		expect(required.checked).toBe(true);
		expect(ifPresent.checked).toBe(false);
	});

	it('reflects a stored if-present selection', () => {
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="if-present"
				setReviewChecksPolicy={noop}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		const required = screen.getByRole('radio', {
			name: /^Require CI checks/,
		}) as HTMLInputElement;
		const ifPresent = screen.getByRole('radio', {
			name: /^Review when no checks exist/,
		}) as HTMLInputElement;
		expect(required.checked).toBe(false);
		expect(ifPresent.checked).toBe(true);
	});

	it('calls setReviewChecksPolicy when a different option is picked', () => {
		const setReviewChecksPolicy = vi.fn();
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="required"
				setReviewChecksPolicy={setReviewChecksPolicy}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		fireEvent.click(screen.getByRole('radio', { name: /^Review when no checks exist/ }));
		expect(setReviewChecksPolicy).toHaveBeenCalledWith('if-present');
	});

	it('includes explanatory copy limiting the no-CI option to repositories without CI', () => {
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="required"
				setReviewChecksPolicy={noop}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		expect(screen.getByText(/Only for repositories with no CI/)).toBeDefined();
		expect(screen.getByText(/not a way to bypass CI that exists/)).toBeDefined();
	});
});
