import { describe, expect, it } from 'vitest';
import { canTerminateRun, terminateButtonLabel, terminateConfirmMessage } from './run-terminate.js';

describe('canTerminateRun', () => {
	it('allows terminate for a running or deferred run', () => {
		expect(canTerminateRun('running')).toBe(true);
		expect(canTerminateRun('deferred')).toBe(true);
	});

	it('disallows terminate for completed and failed runs', () => {
		expect(canTerminateRun('completed')).toBe(false);
		expect(canTerminateRun('failed')).toBe(false);
	});

	it('disallows terminate for an unknown status', () => {
		expect(canTerminateRun('whatever')).toBe(false);
	});
});

describe('terminateButtonLabel', () => {
	it('reads "Terminating…" while the mutation is pending', () => {
		expect(terminateButtonLabel(true)).toBe('Terminating…');
	});

	it('reads "Terminate" when idle', () => {
		expect(terminateButtonLabel(false)).toBe('Terminate');
	});
});

describe('terminateConfirmMessage', () => {
	it('describes cancelling the scheduled retry for a deferred run', () => {
		expect(terminateConfirmMessage('deferred')).toContain('scheduled retry');
	});

	it('describes stopping the running agent for a running run', () => {
		expect(terminateConfirmMessage('running')).toContain('running agent');
	});
});
