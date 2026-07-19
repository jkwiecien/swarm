import { getAllCliQuotas, upsertCliQuota } from '../../db/repositories/cliQuotasRepository.js';
import { discoverCliQuotas } from '../../harness/quota-discovery.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * tRPC router for CLI quotas and capabilities (issue #164).
 *
 * Exposes queries to read the persisted quota snapshot and mutations to trigger
 * manual quota refreshes.
 */
export const quotaRouter = router({
	/**
	 * Get the currently persisted host-local capability and quota snapshots for all CLIs.
	 */
	getQuotas: authedProcedure.query(async () => {
		return await getAllCliQuotas();
	}),

	/**
	 * Run full capability discovery and live quota queries, persist the results,
	 * and return the fresh snapshots.
	 */
	refreshQuotas: authedProcedure.mutation(async () => {
		const snapshots = await discoverCliQuotas(false); // cheap = false for manual refresh
		for (const snapshot of snapshots) {
			await upsertCliQuota(snapshot.cli, snapshot.status, snapshot);
		}
		return snapshots;
	}),
});
