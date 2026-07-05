/**
 * Structured logger — a dependency-free console wrapper mirroring the shape of
 * Cascade's `src/utils/logging.ts` (`logger.info/warn/error/debug` taking a
 * message plus a structured-context object) so code ported from Cascade reads
 * unchanged. Deliberately tiny: SWARM's MVP has no log-shipping requirement, so
 * this stays a wrapper rather than pulling in a logging framework (pino/winston).
 *
 * Two output formats: `json` emits one JSON object per line (`{level,time,msg,
 * ...context}`) for machine parsing/aggregation; `pretty` keeps the readable
 * `[level] msg {json}` form for local dev. Format and minimum level are read
 * from the environment per call, so the router and worker can be tuned
 * independently (see docker-compose.yml / README). `configureLogger` binds a
 * process-wide context (e.g. `{component: 'router'}`) onto every line so a
 * shared log stream stays attributable to the process that produced it.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

// Numeric ordering mirrors Cascade's LOG_LEVELS: a call is emitted only when its
// level is >= the configured minimum.
const LEVEL_WEIGHT: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

// Merged into every line. Set once per process via configureLogger (the router
// and worker each bind their component); empty in unconfigured contexts (tests,
// one-off scripts).
let baseContext: LogContext = {};

/**
 * Bind a process-wide context onto every subsequent log line. Called once at
 * each entry point (router/worker) with `{component}`. Replaces the previous
 * base context rather than merging — each process has a single identity, and
 * replace semantics keep tests able to reset it.
 */
export function configureLogger(context: LogContext): void {
	baseContext = { ...context };
}

function resolveMinLevel(): number {
	const raw = process.env.SWARM_LOG_LEVEL?.toLowerCase();
	if (raw && raw in LEVEL_WEIGHT) {
		return LEVEL_WEIGHT[raw as LogLevel];
	}
	return LEVEL_WEIGHT.info;
}

function resolveFormat(): 'json' | 'pretty' {
	const raw = process.env.SWARM_LOG_FORMAT?.toLowerCase();
	if (raw === 'json' || raw === 'pretty') {
		return raw;
	}
	// Unset: pretty on an interactive terminal, json when piped/containerized so
	// production stdout is aggregator-friendly without any explicit config.
	return process.stdout.isTTY ? 'pretty' : 'json';
}

// A logger must never crash its caller, so JSON.stringify is guarded on two
// fronts: a replacer coerces BigInt (which stringify throws on outright) to a
// string, and a try/catch fallback emits a still-valid line carrying the
// message plus a _logError marker if anything else is unserializable (e.g. a
// circular reference). Call sites pass plain ids/strings today, so this is
// belt-and-suspenders — but the logger is the sanctioned structured path now.
function safeStringify(value: unknown): string {
	return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val));
}

function format(level: LogLevel, message: string, context: LogContext, time: string): string {
	if (resolveFormat() === 'json') {
		try {
			return safeStringify({ level, time, msg: message, ...context });
		} catch (err) {
			return safeStringify({
				level,
				time,
				msg: message,
				_logError: err instanceof Error ? err.message : String(err),
			});
		}
	}
	let suffix = '';
	if (Object.keys(context).length > 0) {
		try {
			suffix = ` ${safeStringify(context)}`;
		} catch (err) {
			suffix = ` {"_logError":${JSON.stringify(err instanceof Error ? err.message : String(err))}}`;
		}
	}
	return `[${level}] ${message}${suffix}`;
}

function emit(level: LogLevel, message: string, context?: LogContext): void {
	if (LEVEL_WEIGHT[level] < resolveMinLevel()) {
		return;
	}
	const merged = { ...baseContext, ...context };
	// ISO 8601 timestamp sorts lexicographically, which log aggregators rely on.
	const line = format(level, message, merged, new Date().toISOString());
	console[level === 'debug' ? 'log' : level](line);
}

export const logger = {
	debug: (message: string, context?: LogContext) => emit('debug', message, context),
	info: (message: string, context?: LogContext) => emit('info', message, context),
	warn: (message: string, context?: LogContext) => emit('warn', message, context),
	error: (message: string, context?: LogContext) => emit('error', message, context),
};
