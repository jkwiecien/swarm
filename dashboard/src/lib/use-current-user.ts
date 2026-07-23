import { useQuery } from '@tanstack/react-query';
import { trpc } from './trpc.js';

/**
 * The signed-in user, via the `auth.me` tRPC query (#281 task 2). `retry: false`
 * so an `UNAUTHORIZED` (no/expired session) surfaces immediately as `isError`
 * rather than being retried — the root layout turns that into a `/login`
 * redirect. Returns the full react-query result so callers can read
 * `data`/`isLoading`/`isError`.
 */
export function useCurrentUser() {
	return useQuery({ ...trpc.auth.me.queryOptions(), retry: false });
}
