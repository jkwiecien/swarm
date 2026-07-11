import { parseArgs } from 'node:util';
import type { ProjectConfig } from '../../config/schema.js';
import { closeDb } from '../../db/client.js';
import {
	findProjectByIdFromDb,
	listAllProjectsFromDb,
} from '../../db/repositories/projectsRepository.js';
import { pruneStaleWorktrees } from '../../worktree/retention.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm worktrees — retention and cleanup for stale worktrees under .swarm-workspaces/

Usage: swarm worktrees prune [--project <id>] [--dry-run]

  --project <id>   Only sweep this project (default: all configured projects)
  --dry-run        Report what would be pruned without removing anything

Requires DATABASE_URL (project config) and REDIS_URL (in-flight check) in the
environment — run via \`npm run worktrees:prune\` (loads .env) or export them
yourself first.`;

async function sweepProject(project: ProjectConfig, dryRun: boolean): Promise<void> {
	out.step(`sweeping project '${project.name}' (${project.id})…`);
	const result = await pruneStaleWorktrees(project, { dryRun });

	out.info(`  kept: ${result.kept.length}`);
	if (result.pruned.length > 0) {
		out.info(`  ${dryRun ? 'would prune' : 'pruned'}: ${result.pruned.length} worktree(s)`);
		for (const p of result.pruned) {
			out.info(`    - ${p}`);
		}
	} else {
		out.info('  pruned: 0');
	}
	if (result.skippedInFlight.length > 0) {
		out.info(`  skipped (in-flight): ${result.skippedInFlight.length}`);
		for (const p of result.skippedInFlight) {
			out.info(`    - ${p}`);
		}
	}
	if (result.skippedDirty.length > 0) {
		out.info(`  skipped (dirty): ${result.skippedDirty.length}`);
		for (const p of result.skippedDirty) {
			out.warn(`    - ${p} (has uncommitted changes — clean up manually if it's no longer needed)`);
		}
	}
	if (result.skippedDeferred.length > 0) {
		out.info(`  skipped (deferred session): ${result.skippedDeferred.length}`);
		for (const p of result.skippedDeferred) out.info(`    - ${p}`);
	}
	if (result.ignored.length > 0) {
		out.info(`  ignored: ${result.ignored.length}`);
	}
}

async function getProjects(projectId?: string): Promise<ProjectConfig[]> {
	if (projectId) {
		const project = await findProjectByIdFromDb(projectId);
		if (!project) {
			throw new Error(`Project with ID '${projectId}' not found in database.`);
		}
		return [project];
	}
	return listAllProjectsFromDb();
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		return subcommand ? 0 : 1;
	}

	if (subcommand !== 'prune') {
		out.error(`unknown worktrees subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	const { values } = parseArgs({
		args: rest,
		options: {
			project: { type: 'string' },
			'dry-run': { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
	});

	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const dryRun = values['dry-run'] ?? false;

	try {
		const projects = await getProjects(values.project);
		for (const project of projects) {
			await sweepProject(project, dryRun);
		}
		return 0;
	} catch (err) {
		out.error(`worktrees prune failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		await closeDb();
	}
}
