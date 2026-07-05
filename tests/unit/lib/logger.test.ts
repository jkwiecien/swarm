import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { configureLogger, logger } from '@/lib/logger.js';

// The logger maps each level to its matching console method (debug→console.log,
// info→console.info, warn→console.warn, error→console.error); capture all four
// to assert on the emitted line.
let logSpy: MockInstance;
let infoSpy: MockInstance;
let warnSpy: MockInstance;
let errorSpy: MockInstance;

beforeEach(() => {
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	// Default to a deterministic format/level for each test; individual tests
	// override via vi.stubEnv. Reset the process-wide base context too.
	vi.stubEnv('SWARM_LOG_FORMAT', 'json');
	vi.stubEnv('SWARM_LOG_LEVEL', 'debug');
	configureLogger({});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('json format', () => {
	it('emits one JSON object per line with level, time, msg and context', () => {
		logger.info('hello', { taskId: 't-1' });

		expect(infoSpy).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
		expect(parsed).toMatchObject({ level: 'info', msg: 'hello', taskId: 't-1' });
		expect(typeof parsed.time).toBe('string');
		expect(() => new Date(parsed.time).toISOString()).not.toThrow();
	});

	it('emits a well-formed line when no context is passed', () => {
		logger.warn('careful');

		const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
		expect(parsed).toMatchObject({ level: 'warn', msg: 'careful' });
	});

	it('routes debug through console.log and error through console.error', () => {
		logger.debug('d');
		logger.error('e');

		expect(JSON.parse(logSpy.mock.calls[0][0] as string).level).toBe('debug');
		expect(JSON.parse(errorSpy.mock.calls[0][0] as string).level).toBe('error');
	});
});

describe('level filtering', () => {
	it('drops calls below SWARM_LOG_LEVEL', () => {
		vi.stubEnv('SWARM_LOG_LEVEL', 'warn');

		logger.debug('d');
		logger.info('i');
		logger.warn('w');
		logger.error('e');

		expect(logSpy).not.toHaveBeenCalled(); // debug suppressed
		expect(infoSpy).not.toHaveBeenCalled(); // info suppressed
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it('defaults to info when SWARM_LOG_LEVEL is unset or invalid', () => {
		vi.stubEnv('SWARM_LOG_LEVEL', 'nonsense');

		logger.debug('d');
		logger.info('i');

		expect(logSpy).not.toHaveBeenCalled(); // debug dropped at the info default
		expect(infoSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(infoSpy.mock.calls[0][0] as string).msg).toBe('i');
	});
});

describe('pretty format', () => {
	it('renders the readable [level] msg {context} form', () => {
		vi.stubEnv('SWARM_LOG_FORMAT', 'pretty');

		logger.info('listening', { port: 3000 });

		expect(infoSpy.mock.calls[0][0]).toBe('[info] listening {"port":3000}');
	});

	it('omits the context suffix when there is nothing to show', () => {
		vi.stubEnv('SWARM_LOG_FORMAT', 'pretty');

		logger.info('ready');

		expect(infoSpy.mock.calls[0][0]).toBe('[info] ready');
	});
});

describe('configureLogger base context', () => {
	it('merges the process-wide context into every line', () => {
		configureLogger({ component: 'worker' });

		logger.info('job done', { jobId: 'j-9' });

		expect(JSON.parse(infoSpy.mock.calls[0][0] as string)).toMatchObject({
			component: 'worker',
			jobId: 'j-9',
		});
	});

	it('lets call-site context override the base context', () => {
		configureLogger({ component: 'worker' });

		logger.info('override', { component: 'pipeline' });

		expect(JSON.parse(infoSpy.mock.calls[0][0] as string).component).toBe('pipeline');
	});

	it('replaces rather than accumulates base context', () => {
		configureLogger({ component: 'router' });
		configureLogger({ component: 'worker' });

		logger.info('x');

		expect(JSON.parse(infoSpy.mock.calls[0][0] as string).component).toBe('worker');
	});
});
