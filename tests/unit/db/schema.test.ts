import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { projectCredentials, projects, runLogs, runs } from '@/db/schema/index.js';

// These tests pin the persisted shape to SWARM's config model (src/config/schema.ts)
// and single-user scope (ai/ARCHITECTURE.md) without needing a live Postgres.
describe('db schema', () => {
	describe('projects', () => {
		const table = getTableConfig(projects);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "projects"', () => {
			expect(table.name).toBe('projects');
		});

		it('persists every ProjectConfig field', () => {
			for (const name of [
				'id',
				'name',
				'repo',
				'repo_root',
				'worktree_root',
				'base_branch',
				'branch_prefix',
				'pm_type',
				'github_projects',
				'credentials',
			]) {
				expect(columns.has(name), `missing column ${name}`).toBe(true);
			}
		});

		it('has no org_id — single-user scope, no organizations table', () => {
			expect(columns.has('org_id')).toBe(false);
		});

		it('stores structured config (github_projects, credentials) as jsonb', () => {
			expect(columns.get('github_projects')?.getSQLType()).toBe('jsonb');
			expect(columns.get('credentials')?.getSQLType()).toBe('jsonb');
			expect(columns.get('github_projects')?.notNull).toBe(true);
			expect(columns.get('credentials')?.notNull).toBe(true);
		});

		it('keys on id and enforces one project per repo', () => {
			expect(columns.get('id')?.primary).toBe(true);
			expect(columns.get('repo')?.isUnique).toBe(true);
		});

		it('applies the PROJECT_DEFAULTS as column defaults', () => {
			expect(columns.get('worktree_root')?.default).toBe('.swarm-workspaces');
			expect(columns.get('base_branch')?.default).toBe('main');
			expect(columns.get('branch_prefix')?.default).toBe('issue-');
			expect(columns.get('max_concurrent_jobs')?.default).toBe(1);
		});
	});

	describe('project_credentials', () => {
		const table = getTableConfig(projectCredentials);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "project_credentials"', () => {
			expect(table.name).toBe('project_credentials');
		});

		it('maps an env-var key to a required secret value', () => {
			expect(columns.get('env_var_key')?.notNull).toBe(true);
			expect(columns.get('value')?.notNull).toBe(true);
		});

		it('cascades from the owning project', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			const ref = fk.reference();
			expect(ref.foreignTable).toBe(projects);
			expect(fk.onDelete).toBe('cascade');
		});

		it('enforces one value per (project, env-var key)', () => {
			const unique = table.indexes.find((i) => i.config.unique);
			expect(unique).toBeDefined();
			expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				'project_id',
				'env_var_key',
			]);
		});
	});

	describe('runs', () => {
		const table = getTableConfig(runs);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "runs"', () => {
			expect(table.name).toBe('runs');
		});

		it('records every column of an agent-run lifecycle', () => {
			for (const name of [
				'id',
				'project_id',
				'task_id',
				'work_item_id',
				'pr_number',
				'phase',
				'engine',
				'model',
				'status',
				'exit_code',
				'timed_out',
				'error',
				'started_at',
				'completed_at',
				'duration_ms',
			]) {
				expect(columns.has(name), `missing column ${name}`).toBe(true);
			}
		});

		it('keys on id and starts a run as "running"', () => {
			expect(columns.get('id')?.primary).toBe(true);
			expect(columns.get('status')?.notNull).toBe(true);
			expect(columns.get('status')?.default).toBe('running');
		});

		it('defaults timed_out to false and requires it', () => {
			expect(columns.get('timed_out')?.notNull).toBe(true);
			expect(columns.get('timed_out')?.default).toBe(false);
		});

		it('stores pr_number as text (GitHub PR numbers stay stringly-typed)', () => {
			expect(columns.get('pr_number')?.getSQLType()).toBe('text');
		});

		it('stamps started_at automatically but leaves completed_at open', () => {
			expect(columns.get('started_at')?.notNull).toBe(true);
			expect(columns.get('completed_at')?.notNull).toBe(false);
		});

		it('cascades from the owning project', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			expect(fk.reference().foreignTable).toBe(projects);
			expect(fk.onDelete).toBe('cascade');
		});

		it('indexes project_id, status, and started_at for the runs list', () => {
			const names = table.indexes.map((i) => i.config.name);
			expect(names).toContain('idx_runs_project_id');
			expect(names).toContain('idx_runs_status');
			expect(names).toContain('idx_runs_started_at');
		});
	});

	describe('run_logs', () => {
		const table = getTableConfig(runLogs);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "run_logs"', () => {
			expect(table.name).toBe('run_logs');
		});

		it('holds one nullable stdout/stderr blob per run', () => {
			expect(columns.get('run_id')?.notNull).toBe(true);
			expect(columns.get('run_id')?.isUnique).toBe(true);
			expect(columns.get('stdout')?.getSQLType()).toBe('text');
			expect(columns.get('stderr')?.getSQLType()).toBe('text');
			expect(columns.get('stdout')?.notNull).toBe(false);
			expect(columns.get('stderr')?.notNull).toBe(false);
		});

		it('cascades from the owning run', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			expect(fk.reference().foreignTable).toBe(runs);
			expect(fk.onDelete).toBe('cascade');
		});
	});
});
