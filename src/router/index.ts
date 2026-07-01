import { createServer } from 'node:http';

// Placeholder router entry point. The real Hono server — webhook signature
// verification, project resolution, and BullMQ enqueue — lands in SWARM-9;
// for now this is just enough of an HTTP service for the Docker Compose stack
// to build and report healthy. Uses the built-in http module deliberately so
// the framework choice (Hono) stays with SWARM-9.
const port = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
	if (req.url === '/health') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', service: 'router' }));
		return;
	}
	res.writeHead(404, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, () => {
	console.log(`swarm-router: listening on :${port}`);
});

// Docker sends SIGTERM on `compose down`/`stop`; exit cleanly so the container
// stops promptly instead of being killed after the grace period.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}
