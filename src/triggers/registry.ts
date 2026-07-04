/**
 * Trigger registry — ported close to verbatim from Cascade's
 * `src/triggers/registry.ts`: handlers are tried in registration order, the
 * first one that matches *and* returns a non-null result wins, and a matching
 * handler returning null means "looked closer, not for me — keep going".
 */

import { logger } from '../lib/logger.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from './types.js';

export class TriggerRegistry {
	private handlers: TriggerHandler[] = [];

	register(handler: TriggerHandler): void {
		this.handlers.push(handler);
		logger.debug('Registered trigger handler', { name: handler.name });
	}

	unregister(name: string): boolean {
		const index = this.handlers.findIndex((h) => h.name === name);
		if (index !== -1) {
			this.handlers.splice(index, 1);
			return true;
		}
		return false;
	}

	/**
	 * Resolve `ctx` to an agent run, or null when no handler claims it — a valid
	 * "not for us" outcome, not an error (ai/CODING_STANDARDS.md "Error
	 * handling"). A handler that throws aborts the dispatch: the error propagates
	 * to the queue layer so the job is marked failed rather than half-handled.
	 */
	async dispatch(ctx: TriggerContext): Promise<TriggerResult | null> {
		for (const handler of this.handlers) {
			if (!handler.matches(ctx)) continue;
			logger.info('Trigger matched', { handler: handler.name, source: ctx.source });
			const result = await handler.handle(ctx);
			if (result !== null) return result;
			logger.debug('Trigger handler returned null, continuing', { handler: handler.name });
		}
		logger.debug('No trigger matched', { source: ctx.source });
		return null;
	}

	getHandlers(): TriggerHandler[] {
		return [...this.handlers];
	}
}

export function createTriggerRegistry(): TriggerRegistry {
	return new TriggerRegistry();
}
