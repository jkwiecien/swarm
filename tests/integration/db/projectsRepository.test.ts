import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { writeProjectCredential } from '../../../src/db/repositories/credentialsRepository.js';
import {
	createProjectInDb,
	deleteProjectFromDb,
	findProjectByIdFromDb,
	getProjectByIdFromDb,
	listAllProjectsFromDb,
} from '../../../src/db/repositories/projectsRepository.js';
import { projectCredentials } from '../../../src/db/schema/projectCredentials.js';
import { createMockProjectConfig } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('projectsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	describe('createProjectInDb', () => {
		it('inserts a brand new project and can resolve it by ID', async () => {
			const config = createMockProjectConfig({
				id: 'proj-new',
				name: 'New Project',
				repo: 'jkwiecien/new-repo',
				maxConcurrentJobs: 4,
			});
			await createProjectInDb(config);

			const resolved = await findProjectByIdFromDb('proj-new');
			expect(resolved).toBeDefined();
			expect(resolved?.name).toBe('New Project');
			expect(resolved?.maxConcurrentJobs).toBe(4);
		});

		it('rejects if the project ID already exists', async () => {
			await seedProject({ id: 'dup-id', name: 'Original Name', repo: 'jkwiecien/original' });

			const duplicateConfig = createMockProjectConfig({
				id: 'dup-id',
				name: 'Duplicate Name',
				repo: 'jkwiecien/duplicate',
			});
			await expect(createProjectInDb(duplicateConfig)).rejects.toThrow();

			// Assert original row remains untouched
			const resolved = await findProjectByIdFromDb('dup-id');
			expect(resolved?.name).toBe('Original Name');
		});
	});

	describe('deleteProjectFromDb', () => {
		it('removes the project and cascade deletes all related credentials', async () => {
			await seedProject({ id: 'proj-del', repo: 'jkwiecien/del-repo' });
			await writeProjectCredential('proj-del', 'API_KEY', 'secret-val');

			// Assert both row and credential exist initially
			const projectBefore = await findProjectByIdFromDb('proj-del');
			expect(projectBefore).toBeDefined();

			const credBefore = await getDb()
				.select()
				.from(projectCredentials)
				.where(eq(projectCredentials.projectId, 'proj-del'));
			expect(credBefore).toHaveLength(1);

			// Delete the project
			await deleteProjectFromDb('proj-del');

			// Assert both are gone
			const projectAfter = await findProjectByIdFromDb('proj-del');
			expect(projectAfter).toBeUndefined();

			const credAfter = await getDb()
				.select()
				.from(projectCredentials)
				.where(eq(projectCredentials.projectId, 'proj-del'));
			expect(credAfter).toHaveLength(0);
		});

		it('does not throw when deleting a project ID that does not exist', async () => {
			await expect(deleteProjectFromDb('non-existent')).resolves.toBeUndefined();
		});
	});

	describe('listAllProjectsFromDb', () => {
		it('returns all projects ordered by name ascending', async () => {
			await seedProject({ id: 'proj-c', name: 'Charlie Project', repo: 'jkwiecien/charlie' });
			await seedProject({ id: 'proj-a', name: 'Alpha Project', repo: 'jkwiecien/alpha' });
			await seedProject({ id: 'proj-b', name: 'Bravo Project', repo: 'jkwiecien/bravo' });

			const list = await listAllProjectsFromDb();
			expect(list).toHaveLength(3);
			expect(list[0].name).toBe('Alpha Project');
			expect(list[1].name).toBe('Bravo Project');
			expect(list[2].name).toBe('Charlie Project');
		});

		it('returns an empty array when no projects exist', async () => {
			const list = await listAllProjectsFromDb();
			expect(list).toEqual([]);
		});
	});

	describe('getProjectByIdFromDb', () => {
		it('resolves a project by ID and returns undefined if not found', async () => {
			await seedProject({ id: 'proj-get', name: 'Get Me', repo: 'jkwiecien/get-repo' });

			const project = await getProjectByIdFromDb('proj-get');
			expect(project).toBeDefined();
			expect(project?.name).toBe('Get Me');

			const missing = await getProjectByIdFromDb('non-existent');
			expect(missing).toBeUndefined();
		});
	});
});
