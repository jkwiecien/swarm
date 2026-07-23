import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '../../../src/api/router';
import { API_URL } from './api.js';
import { queryClient } from './query-client.js';

// Session auth (#281 task 2): the dashboard no longer sends a build-time bearer
// token. Every request carries the HTTP-only session cookie via
// `credentials: 'include'`, and the backend resolves the caller from it. On a
// same-origin deploy the browser would send the cookie anyway, but `include`
// keeps a cross-origin dev setup (`VITE_API_URL`) working too.
export const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${API_URL}/trpc`,
			fetch: (url, options) => fetch(url, { ...options, credentials: 'include' }),
		}),
	],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
