import { pingRouter } from './routers/ping.js';
import { projectsRouter } from './routers/projects.js';
import { runsRouter } from './routers/runs.js';
import { scmRouter } from './routers/scm.js';
import { settingsRouter } from './routers/settings.js';
import { router } from './trpc.js';

export const appRouter = router({
	ping: pingRouter,
	projects: projectsRouter,
	runs: runsRouter,
	scm: scmRouter,
	settings: settingsRouter,
});

export type AppRouter = typeof appRouter;
