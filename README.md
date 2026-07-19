# SWARM

**Federated Multi-Agent Automation Framework** — a local-first system that
automates software work while keeping source code, compute, and local tooling
on the developer's machine.

The MVP runs a local router, Redis/Postgres stack, host worker, and dashboard.
GitHub reaches the router through a public HTTPS webhook endpoint, usually via a
Cloudflare Tunnel. The long-term architecture and protocol are documented in
[`PROJECT.md`](./PROJECT.md); this README is the shortest path to a working
checkout.

## How it works

```text
GitHub → HTTPS webhook → Router → durable Postgres dispatch → Redis wake-up
                                                        ↓
                                      host Worker → isolated worktree → agent CLI
                                                        ↓
                                      commit / PR / review / board update
```

- Planning and Implementation start from GitHub Projects board status changes.
- Review starts when a SWARM-authored pull request opens or its checks complete.
- Respond-to-review and Respond-to-CI start from pull-request lifecycle events.
- The worker runs `claude`, `agy` (Antigravity), or `codex` in an isolated
  worktree and performs deterministic GitHub delivery after the agent exits.
- Pending work is durable in Postgres; Redis carries wake-ups, not the source
  of truth. See [`docs/pipeline.md`](./docs/pipeline.md) for lifecycle details.

## Prerequisites

- Node.js 22 or newer and npm
- Docker Compose
- Git
- Authenticated agent CLIs (`claude`, `agy`, and/or `codex`)
- A GitHub repository, Projects v2 board, webhook, and separate SWARM
  implementer/reviewer credentials

## Quick start

Run the following from the repository root:

```bash
npm install
cp .env.docker.example .env       # set passwords
cd web && npm install && cd ..
docker compose up -d --build      # Postgres, Redis, and router
npm run db:migrate
npm run db:seed                   # loads swarm.config.json into Postgres
swarm users add you@example.com --admin    # create your dashboard user, then
swarm users set-password you@example.com   # set its login password (prompts, no echo)
```

Start these processes in separate terminals:

```bash
npm run dev:dashboard             # dashboard API on 127.0.0.1:3101
npm run dev:web                   # Vite dashboard on localhost:5173
npm run dev:worker                # host worker
```

Open <http://localhost:5173>. For a compiled self-hosted dashboard, run
`npm run start:dashboard` and open <http://localhost:3101> instead.

The worker is intentionally host-run: it needs local Git worktrees, agent CLI
authentication, and the developer's PATH. The dashboard uses per-user session
auth: sign in at `/login` with a user created via `swarm users` (above);
`/health` is unauthenticated, while every API request carries an HTTP-only
session cookie. See [`docs/operations.md`](./docs/operations.md) for health
checks, ports, webhook setup, and troubleshooting.

## Common commands

```bash
# Stack lifecycle
npm run swarm -- start
npm run swarm -- start --build
npm run swarm -- stop
npm run swarm -- status
npm run swarm -- logs
npm run swarm -- logs router -f

# Configuration and database
npm run db:migrate
npm run db:seed
npm run swarm -- config apply

# Queue and worktrees
npm run queue:clear
npm run worktrees:prune

# Verification
npm run verify
npm test
```

`npm run swarm -- <command>` runs the CLI from source. After `npm run build`,
the `swarm` binary can be invoked directly. `queue:clear` cancels waiting
dispatches but does not terminate an active agent; stop the worker first when
clearing work before a restart. Detailed operator guidance is in
[`docs/operations.md`](./docs/operations.md).

## Configuration

Configuration has three layers:

- `.env` — host and process settings such as database, Redis, ports, logging,
  dashboard authentication, and credential encryption.
- `swarm.config.json` — per-project repository, worktree, GitHub Projects,
  credential references, agent, and pipeline settings. Apply changes with
  `npm run db:seed` or `swarm config apply`.
- Dashboard global settings — app-wide settings stored in Postgres and edited
  through the dashboard API.

The complete option catalogue, defaults, and source-of-truth schemas are in
[`docs/configuration.md`](./docs/configuration.md).

## Documentation

- [`docs/operations.md`](./docs/operations.md) — setup, run modes, ports,
  health checks, operator CLI, migrations, queues, worktrees, and webhooks
- [`docs/configuration.md`](./docs/configuration.md) — complete environment,
  project, and global-settings reference
- [`docs/pipeline.md`](./docs/pipeline.md) — phases, triggers, security, and
  provider boundaries
- [`docs/status.md`](./docs/status.md) — implemented MVP areas and current
  roadmap snapshot
- [`ai/ARCHITECTURE.md`](./ai/ARCHITECTURE.md) — engineering architecture and
  implementation conventions
- [`ai/TESTING.md`](./ai/TESTING.md) — test strategy and verification guidance
- [`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md) — exposing the
  local router to GitHub
- [`docs/github-projects-v2-api.md`](./docs/github-projects-v2-api.md) —
  Projects v2 API and webhook details
- [`docs/decisions/`](./docs/decisions/) — architecture decision records
- [`PROJECT.md`](./PROJECT.md) — long-term architecture design and protocol

The live task backlog is the [SWARM GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1).

## Contributing

Read [`ai/RULES.md`](./ai/RULES.md) before making changes. Run
`npm run verify` before submitting a change. GitHub Actions runs the same
verification command for every pull request.

## License

SWARM is licensed under the [Apache License 2.0](./LICENSE).
