#!/usr/bin/env node
// Thin launcher for the `swarm` operator CLI (see `package.json` "bin"). Runs
// the compiled build, so `npm run build` must have run first. To run from source
// without building, use the `swarm` npm script (tsx): `npm run swarm -- <cmd>`.
import { run } from '../dist/cli/index.js';

process.exit(await run(process.argv.slice(2)));
