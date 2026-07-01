// Placeholder worker entry point. The real BullMQ consumer — pull a job, provision
// a worktree, run the harness, clean up — lands in SWARM-17; for now this is a
// long-running no-op so the Docker Compose stack has a worker service that stays
// up. No queue/Redis wiring yet on purpose (that's SWARM-17).
console.log('swarm-worker: started (placeholder — no queue wiring yet)');

// Keep the process alive without busy-looping; the timer holds the event loop open.
const keepAlive = setInterval(() => {}, 1 << 30);

// Docker sends SIGTERM on `compose down`/`stop`; exit cleanly on it.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		clearInterval(keepAlive);
		process.exit(0);
	});
}
