import { authedProcedure, router } from '../trpc.js';

/**
 * Authentication-state API (#281 task 2). `me` returns the current `SwarmUser`
 * resolved from the session cookie — the dashboard uses it to know who is signed
 * in and to gate the app (a null user is a `UNAUTHORIZED` from `authedProcedure`,
 * which the SPA turns into a redirect to `/login`).
 *
 * It returns only the public `SwarmUser` read model — never the password hash,
 * the session token, or any other secret. Login/logout themselves are plain Hono
 * routes (`POST /auth/login`, `POST /auth/logout` in `src/dashboard.ts`), not
 * tRPC procedures, because they set and clear the HTTP-only session cookie.
 */
export const authRouter = router({
	me: authedProcedure.query(({ ctx }) => ctx.user),
});
