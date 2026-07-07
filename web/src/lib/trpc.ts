import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '../../../src/api/router';
import { API_URL } from './api.js';
import { queryClient } from './query-client.js';

const DASHBOARD_TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN as string | undefined;

export const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${API_URL}/trpc`,
			headers: () => (DASHBOARD_TOKEN ? { Authorization: `Bearer ${DASHBOARD_TOKEN}` } : {}),
		}),
	],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
