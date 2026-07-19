import { initTRPC, TRPCError } from '@trpc/server';

import type { SwarmUser } from '../identity/schema.js';

/**
 * The tRPC request context (#281 task 2). `user` is the authenticated
 * `SwarmUser` resolved from the request's session cookie, or `null` for an
 * unauthenticated request. It is built in the `@hono/trpc-server` `createContext`
 * (`src/dashboard.ts`) from `resolveSession`; procedures never touch the cookie
 * directly.
 */
// A `type` (not an `interface`) so it carries an implicit index signature and is
// assignable to the `@hono/trpc-server` `createContext` return type
// (`Record<string, unknown>`), which we build it from in `src/dashboard.ts`.
export type TrpcContext = {
	user: SwarmUser | null;
};

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * A procedure open to any caller, authenticated or not — used only for `ping`
 * (the liveness probe). Every other procedure is `authedProcedure`.
 */
export const publicProcedure = t.procedure;

/**
 * A procedure that requires an authenticated session: it throws `UNAUTHORIZED`
 * when `ctx.user` is null and otherwise narrows the context so downstream
 * resolvers see a non-null `user`. This is what makes a session — not a shared
 * secret — the thing that authorizes `/trpc/*`.
 */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.user) {
		throw new TRPCError({ code: 'UNAUTHORIZED' });
	}
	return next({ ctx: { user: ctx.user } });
});
