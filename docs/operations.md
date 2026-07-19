# Operations

This guide covers local setup, dashboard access, operator commands, ports,
database migrations, and webhook exposure. The short setup path remains in the
root [README](../README.md); this is the detailed operational reference.

## Running the stack (local)

Postgres, Redis, and the router run in Docker Compose; the **worker runs on the host**:

```bash
cp .env.docker.example .env   # adjust POSTGRES_PASSWORD / ports / DASHBOARD_TOKEN if needed
docker compose up -d --build  # postgres, redis, router (NOT the worker) — detached
npm run db:migrate            # apply the Postgres schema (uses DATABASE_URL from .env)
npm run db:seed               # load swarm.config.json into Postgres (projects + credentials)
cd web && npm install && cd .. # install web dashboard dependencies
npm run dev:dashboard         # start the dashboard API on the host (default port 3101) — requires DASHBOARD_TOKEN in .env
npm run dev:web               # start the Vite dev server (default port 5173)
npm run dev:worker            # start the worker on the host (or: npm run build && npm run start:worker); SWARM_WORKER_CONCURRENCY in .env sets how many jobs run at once (default 1)
```
`swarm start`, `npm run dev:dashboard`, `npm run dev:worker`, and their production
start variants apply pending committed migrations before serving requests or processing
jobs. `dev:worker` is intentionally stable: source edits do not restart it and abort a
live agent. Use `npm run dev:worker:watch` only while developing the worker itself and
when no real pipeline run is active. The worker also applies migrations **in-process on
every start**, so either mode refuses to serve jobs against a stale schema. The explicit
`npm run db:migrate` step remains useful for setup and maintenance, and is safe to run
repeatedly.

The dashboard can be run in two modes:

- **Development Mode (with Hot-Reloading)**:
  Run the backend API and the Vite development server side-by-side:
  ```bash
  npm run dev:dashboard         # Starts the dashboard API on port 3101
  npm run dev:web               # Starts the Vite dev server on port 5173
  ```
  Open `http://localhost:5173` in your browser. Code changes will hot-reload automatically.

- **Self-Hosted Mode (Production Build)**:
  Because the compiled assets under `web/dist` are ignored in git, you must compile the frontend assets if you want the dashboard API server to serve the SPA statically. You can run both steps with a single command:
  ```bash
  npm run start:dashboard       # Compiles web assets and starts dashboard API on port 3101
  ```
  Open `http://localhost:3101` in your browser. The dashboard API will serve the compiled files as a fallback for any non-API/non-health routes.

The dashboard API requires `DASHBOARD_TOKEN` to be set in your `.env` file and throws on startup if it is missing. Because it binds to `127.0.0.1` and uses Hono's `bearerAuth` middleware, every dashboard API request (except `/health`) must include the token in the `Authorization` header. Future frontends read the token from local configuration rather than displaying a login screen.

You can verify the dashboard API is running and authenticated using `curl`:
```bash
# /health check requires no authentication
curl http://localhost:3101/health

# Authenticated tRPC request
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" http://localhost:3101/trpc/ping.ping
```

The `swarm` operator CLI (`src/cli/`, SWARM-22) wraps the config + stack steps above:

- `swarm init` — scaffolds `.env` (from `.env.docker.example`) and a `swarm.config.json` project-config template, validating it if one already exists.
- `swarm config apply` (a.k.a. `npm run db:seed`, SWARM-56) — loads that file's projects and their referenced credentials into Postgres, which is where the router and worker actually resolve config from (`swarm.config.json` is otherwise scaffold/documentation only). `npm run db:seed` runs with `--env-file=.env`, so it sees `DATABASE_URL` and credential secrets automatically; standalone `swarm config apply` reads only the ambient environment — export those vars first, or just use `npm run db:seed` (a reference whose env var is unset is silently skipped).
- `swarm start [--build]` / `swarm stop [-v]` — bring the Compose stack up/down.
- `swarm status` — shows the container states and probes the router's `/health`.
- `swarm logs [service] [-f]` — tails the logs.
- `swarm queue clear` (a.k.a. `npm run queue:clear`) — cancels every waiting dispatch (pending, capacity-blocked, and retry-scheduled — the canonical durable queue, issue #284) and drains their queued wake-ups plus any legacy jobs from Redis. Cancelled dispatches can never be resurrected by a retry, slot release, or reconciliation. It deliberately does not cancel an active run; stop the worker first when clearing work before restarting it. Requires both `DATABASE_URL` and `REDIS_URL`.
- `swarm worktrees prune [--project <id>] [--dry-run]` (a.k.a. `npm run worktrees:prune`) — reclaims stale `task-<id>` worktrees under `.swarm-workspaces/` that are no longer in use and have no uncommitted changes.
- `swarm users <add|list|grant-admin|revoke-admin>` — manages SWARM users (the multi-user foundation, issue #281): `add <identifier> [--name <displayName>] [--admin]` creates a user by login handle (username/email) and optionally makes them the installation admin; `list` lists them; `grant-admin`/`revoke-admin <identifier>` toggle the installation-admin role. Requires `DATABASE_URL`. These rows are not yet used by the running auth path — the dashboard still authenticates with `DASHBOARD_TOKEN`; they sit ready for session auth.

It manages only the containerized stack — the worker still runs on the host (`npm run dev:worker`). Run it from source with `npm run swarm -- <command>`, or `npm run build` and invoke the `swarm` bin directly.

The worker isn't containerized because it provisions Git worktrees and spawns the `claude` / `antigravity` CLIs — those need the developer's own PATH, authentication, and config, which a container wouldn't have. Running it on the host is the local-first fit. It connects to the Compose Redis/Postgres over their published host ports (`REDIS_URL` / `DATABASE_URL` in `.env`), so **`git` and the `claude` / `antigravity` CLIs must be installed and authenticated on your machine** for the worker to get past provision/spawn.

The Postgres schema (project config + credentials at rest) is defined with **Drizzle** in `src/db/` — `npm run db:generate` regenerates migrations from the schema, `npm run db:migrate` applies them. Credentials are encrypted with AES-256-GCM before storage when `CREDENTIAL_MASTER_KEY` is set (plaintext otherwise, for local dev).

SWARM's host ports are offset from Cascade's defaults (router `3100` vs `3000`, dashboard `3101` vs `3001`, Postgres `5433` vs `5432`, Redis `6380` vs `6379`) so both stacks can run in parallel without a host-port clash — the compose project name is fixed to `swarm`, giving it its own network and volumes. Override any of them via `ROUTER_PORT` / `DASHBOARD_PORT` / `POSTGRES_PORT` / `REDIS_PORT` in `.env`.

The router exposes a health check at `http://localhost:${ROUTER_PORT:-3100}/health`; the dashboard exposes one at `http://localhost:${DASHBOARD_PORT:-3101}/health` plus a tRPC endpoint at `/trpc`. The router's webhook receiver (`POST /github/webhook`) verifies HMAC signatures, resolves the project, and applies a loop-prevention drop gate (SWARM-9) for both repo-scoped SCM events and the GitHub Projects board event, then hands off to the job queue. From there, a trigger registry dispatches each event to the pipeline phase it names — see the [pipeline guide](./pipeline.md) and [status snapshot](./status.md) for implementation details.

To let GitHub reach this local router with webhooks, expose it over a public HTTPS URL with a Cloudflare Tunnel — see **[`cloudflare-tunnel.md`](./cloudflare-tunnel.md)** for the setup (a quick ephemeral tunnel for dev, a CLI-managed named tunnel for a stable URL, or a dashboard-created tunnel run as an opt-in `cloudflared` service in `docker-compose.yml` so it starts with the rest of the stack) and the GitHub webhook configuration.
