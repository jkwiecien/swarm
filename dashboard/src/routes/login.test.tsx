// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth.js', () => ({ login: vi.fn() }));
vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));

import { login } from '@/lib/auth.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { LoginScreen } from './login.js';

// Minimal react-query-shaped results for the two states the screen branches on:
// unauthenticated (show the form) and resolved (redirect into the app). Only the
// `data`/`isLoading` fields the screen reads matter.
// biome-ignore lint/suspicious/noExplicitAny: a partial query result is enough for these branches.
const UNAUTHENTICATED = { data: undefined, isLoading: false } as any;
const RESOLVED_ADMIN = {
	data: { id: '1', identifier: 'localhost-admin', displayName: 'Local Admin', instanceAdmin: true },
	isLoading: false,
	// biome-ignore lint/suspicious/noExplicitAny: a partial query result is enough for these branches.
} as any;

// Render the real LoginScreen inside a minimal memory router + query client, so
// its useNavigate/useQueryClient hooks work; only the network `login` call is
// mocked. A stub "/" stands in for the app the user lands on after signing in.
function renderLogin() {
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const loginRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/login',
		component: LoginScreen,
	});
	const homeRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/',
		component: () => <div>home-screen</div>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([loginRoute, homeRoute]),
		history: createMemoryHistory({ initialEntries: ['/login'] }),
	});
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe('LoginScreen', () => {
	beforeEach(() => {
		vi.mocked(login).mockReset();
		vi.mocked(useCurrentUser).mockReset().mockReturnValue(UNAUTHENTICATED);
	});

	it('redirects a resolved user into the app without showing the form', async () => {
		// e.g. single-user mode, where the API resolves the local admin with no
		// session — a direct visit to /login skips the screen.
		vi.mocked(useCurrentUser).mockReturnValue(RESOLVED_ADMIN);
		renderLogin();

		expect(await screen.findByText('home-screen')).not.toBeNull();
		expect(screen.queryByLabelText(/username or email/i)).toBeNull();
		expect(login).not.toHaveBeenCalled();
	});

	it('submits the entered credentials and navigates into the app on success', async () => {
		vi.mocked(login).mockResolvedValue({ ok: true });
		renderLogin();

		fireEvent.change(await screen.findByLabelText(/username or email/i), {
			target: { value: 'ada@example.com' },
		});
		fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'hunter2' } });
		fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

		await waitFor(() => expect(login).toHaveBeenCalledWith('ada@example.com', 'hunter2'));
		expect(await screen.findByText('home-screen')).not.toBeNull();
	});

	it('shows an error and stays on the form when login fails', async () => {
		vi.mocked(login).mockResolvedValue({ ok: false, error: 'Invalid credentials.' });
		renderLogin();

		fireEvent.change(await screen.findByLabelText(/username or email/i), {
			target: { value: 'ada@example.com' },
		});
		fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
		fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

		expect((await screen.findByRole('alert')).textContent).toContain('Invalid credentials.');
		expect(screen.queryByText('home-screen')).toBeNull();
	});
});
