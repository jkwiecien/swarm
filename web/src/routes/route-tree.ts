import { rootRoute } from './__root.js';
import { indexRoute } from './index.js';
import { projectsIndexRoute } from './projects/index.js';

export const routeTree = rootRoute.addChildren([indexRoute, projectsIndexRoute]);
