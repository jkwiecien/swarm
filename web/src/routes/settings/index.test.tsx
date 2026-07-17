// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { mockUseTheme } = vi.hoisted(() => ({ mockUseTheme: vi.fn() }));

vi.mock('@/components/theme/theme-provider.js', () => ({
	useTheme: mockUseTheme,
}));

import { AppearancePanel } from './index.js';

describe('AppearancePanel', () => {
	it('renders all three theme options as accessible radios', () => {
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: false,
			isError: false,
		});
		render(<AppearancePanel />);

		expect(screen.getByRole('radio', { name: /^Dark/ })).not.toBeNull();
		expect(screen.getByRole('radio', { name: /^Light/ })).not.toBeNull();
		expect(screen.getByRole('radio', { name: /^System default/ })).not.toBeNull();
	});

	it('checks the option matching the explicit preference, not the resolved theme', () => {
		// preference is 'system' while the OS happens to resolve to dark — the
		// radio group must reflect the saved choice, never the resolved color.
		mockUseTheme.mockReturnValue({
			preference: 'system',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: false,
			isError: false,
		});
		render(<AppearancePanel />);

		expect(
			(screen.getByRole('radio', { name: /^System default/ }) as HTMLInputElement).checked,
		).toBe(true);
		expect((screen.getByRole('radio', { name: /^Dark/ }) as HTMLInputElement).checked).toBe(false);
		expect((screen.getByRole('radio', { name: /^Light/ }) as HTMLInputElement).checked).toBe(false);
	});

	it('calls setTheme with the selected value', () => {
		const setTheme = vi.fn();
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme,
			isPending: false,
			isError: false,
		});
		render(<AppearancePanel />);

		fireEvent.click(screen.getByRole('radio', { name: /^Light/ }));
		expect(setTheme).toHaveBeenCalledWith('light');

		fireEvent.click(screen.getByRole('radio', { name: /^System default/ }));
		expect(setTheme).toHaveBeenCalledWith('system');
	});

	it('disables every option while a save is pending', () => {
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: true,
			isError: false,
		});
		render(<AppearancePanel />);

		for (const radio of screen.getAllByRole('radio') as HTMLInputElement[]) {
			expect(radio.disabled).toBe(true);
		}
	});

	it('shows an error banner with the message when saving fails', () => {
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: false,
			isError: true,
			errorMessage: 'save failed',
		});
		render(<AppearancePanel />);

		expect(screen.getByText(/Failed to save appearance/)).not.toBeNull();
		expect(screen.getByText(/save failed/)).not.toBeNull();
	});
});
