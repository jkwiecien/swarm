/**
 * Minimal structured logger — a thin console wrapper mirroring the shape of
 * Cascade's `src/utils/logging.ts` (`logger.info/warn/error/debug` taking a
 * message plus a structured-context object) so code ported from Cascade reads
 * unchanged. Deliberately tiny: SWARM's MVP has no log-shipping requirement, so
 * this stays a wrapper rather than pulling in a logging framework. Swap the
 * implementation here if that changes; call sites don't need to.
 */

type LogContext = Record<string, unknown>;

function emit(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: LogContext) {
	const line = context ? `${message} ${JSON.stringify(context)}` : message;
	console[level === 'debug' ? 'log' : level](`[${level}] ${line}`);
}

export const logger = {
	debug: (message: string, context?: LogContext) => emit('debug', message, context),
	info: (message: string, context?: LogContext) => emit('info', message, context),
	warn: (message: string, context?: LogContext) => emit('warn', message, context),
	error: (message: string, context?: LogContext) => emit('error', message, context),
};
