import { pingRouter } from './routers/ping.js';
import { projectsRouter } from './routers/projects.js';
import { runsRouter } from './routers/runs.js';
import { router } from './trpc.js';

export const appRouter = router({
	ping: pingRouter,
	projects: projectsRouter,
	runs: runsRouter,
});

export type AppRouter = typeof appRouter;
