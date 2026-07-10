# SWARM

**Federated Multi-Agent Automation Framework** — a local-first alternative to centralized, cloud-only coding-agent platforms (e.g. Devin). SWARM automates software engineering workflows end-to-end (plan → implement → respond to review) while keeping source code, compute, and local tooling entirely on the developer's own machine.

> Full architecture, protocol spec, and implementation roadmap: **[`PROJECT.md`](./PROJECT.md)** — the baseline Architecture Design Document (ADD). This README is the short orientation; `PROJECT.md` is the source of truth for exact message shapes, phases, and task breakdown.

> **MVP note**: the "Cloud" half of the architecture below (Cloud Run / Pub/Sub / Firestore) is `PROJECT.md`'s long-term design and is **not** being built yet. The MVP copies [Cascade](https://github.com/mongrel-intelligence/cascade)'s shape instead — a local router + queue in Docker Compose plus a host-run worker, reachable from GitHub via a Cloudflare Tunnel — and targets **GitHub Projects** as its PM tool and **GitHub** as its sole SCM, single-user. See `ai/ARCHITECTURE.md` for the MVP architecture and the [GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1) for the current backlog.

**Contents**: [Core idea](#core-idea) · [Architecture at a glance](#architecture-at-a-glance-mvp) · [Pipeline phases](#pipeline-phases) · [Security model](#security-model) · [Extensibility](#extensibility) · [Running the stack](#running-the-stack-local) · [Configuration](#configuration) · [Status](#status) · [Contributing](#contributing)

## Core idea

Traditional cloud agent platforms replicate the developer's environment in ephemeral containers — slow, expensive, and hard to keep in sync with local SDKs, emulators, and caches. SWARM's long-term vision (`PROJECT.md` §2.2, not being built yet) flips this with a stateless cloud orchestrator that never sees source code, paired with a local daemon that does the actual work. The **MVP gets there by copying Cascade's local-only shape** instead: everything — router, queue, worker — runs on the developer's own machine, with GitHub reaching it through a Cloudflare Tunnel rather than a cloud ingress service.

## Architecture at a glance (MVP)

```
GitHub (repo + Projects v2)
   │  webhooks
   ▼
Cloudflare Tunnel  (external, not SWARM's concern — just a public HTTPS URL)
   ▼
Router  (Hono HTTP server, Docker container)
   — verifies webhook signatures, resolves the SWARM project, enqueues a job
   ▼
BullMQ / Redis  (job queue, Docker container)
   ▼
Worker  (host process — NOT containerized; needs local git + agent CLIs)
   — resolves trigger handler → git worktree add (isolated sandbox) → claude / antigravity-cli (CWD = worktree)
   — commit + push → PR opened/updated → GitHub Projects item updated

Dashboard  (Hono + tRPC, host process, 127.0.0.1-only)
   — self-hosted config/credentials API; a web/ frontend is in progress (see "Status")
```

- **Router**: Node.js/TypeScript, Hono — verifies GitHub webhook signatures, resolves the project, enqueues jobs.
- **Queue**: BullMQ on Redis — retries, backoff, and a configurable worker concurrency (`SWARM_WORKER_CONCURRENCY`, default 1). PR review-lifecycle jobs (`pull_request`/`pull_request_review`/`check_suite`) always queue ahead of PM-board jobs (`projects_v2_item`, which drive Planning/Implementation) regardless of that setting, so a review never sits behind a multi-minute implementation run (`src/queue/producer.ts`'s `priorityFor`).
- **Worker**: drives the worktree + harness lifecycle, invokes `claude` / `antigravity` / `codex`, streams their stdout/stderr, pushes and opens PRs. Runs on the host (not containerized) so the agent CLIs have the developer's PATH/auth/config.
- **Dashboard**: self-hosted config/credentials API, also host-run — see "Running the stack" below.
- **Postgres**: project config, credentials, run history.
- Router, Redis, and Postgres run in one Docker Compose stack; the worker and dashboard run alongside on the host — one machine either way, see `PROJECT.md` §2.1 and `ai/ARCHITECTURE.md`.

The original cloud-engine design (Cloud Run + Pub/Sub + Firestore + a gRPC-connected daemon) is deferred — see `PROJECT.md` §2.2/§3 for that design once it's revisited.

## Pipeline phases

Each phase's agent CLI and model are configurable per project, per phase, via `swarm.config.json`'s `agents` block (`src/harness/models.ts` is the catalog of valid `cli`/`model` combinations) — the descriptions below are the code's own defaults when a project doesn't override them. Planning and Implementation are the only two phases that move the board's Status themselves, and each does so conditionally on an `autoAdvance` setting (also per-phase, in `swarm.config.json`'s `pipeline` block): Planning defaults to **off** (a human reviews the plan and moves it to "ToDo" themselves), Implementation defaults to **on** (moves straight to "In review" once the PR is up).

1. **Planning** (Claude Code by default) — item moves to "Planning" → the worker provisions a detached worktree, the planning agent reads the code graph and writes `proposed_plan.md` → plan is posted back to the board. Moves the item to "ToDo" itself if `autoAdvance` is on for this project; otherwise a human moves it once they've reviewed the plan. If `autoSplit` is on (default) and the agent judges the item too large for a single PR, it **splits** it: the original item becomes the smaller first task (re-scoped, possibly renamed), and the rest is spawned as sibling items — each created in "Planning" so it gets planned on its own, tagged `swarm:split-child` so it never auto-advances, and carrying a comment explaining the split. A human moves those siblings to "ToDo" in the order they choose.
2. **Implementation** (Claude Code by default) — item moves to "ToDo" → the phase reports the pickup by moving the item to "In progress" (always, regardless of `autoAdvance`) → the worker opens a worktree on the task branch, the agent implements the plan, runs tests, commits, pushes, opens a PR via `gh` → PR linked back to the board, and the item moves to "In review" if `autoAdvance` is on.
3. **Review** (Claude Code, reviewer persona) — PR opened / checks pass → the reviewer persona reviews the diff and posts a formal `gh pr review` (approve / request changes / comment).
4. **Respond to Review** (Claude Code, implementer persona) — the reviewer submits a review with changes requested → the worker opens a worktree on the PR branch, the implementer persona processes the full batch of review comments (fix, or push back with a rationale) → replies posted to the review thread.
5. **Respond to CI** (Claude Code, implementer persona) — a check suite on a SWARM-authored PR fails → the worker opens a worktree on the PR branch, the implementer persona inspects the failing checks and pushes a surgical fix (or reports that no code change was warranted). A per-PR attempt cap stops a fix that never turns CI green from looping forever.

## Security model

- **Minimal localhost-bound auth guard** (MVP): The dashboard binds to `127.0.0.1` rather than `0.0.0.0` and requires a shared-secret token (`DASHBOARD_TOKEN`) for every request except `/health`. This local-first security replaces Cascade's full session/bcrypt/multi-org login system, and is only revisited if SWARM ever needs remote access or multi-user support.
- **Dual-persona GitHub credentials** (MVP): separate implementer/reviewer tokens, borrowed from Cascade's loop-prevention model — a persona never reacts to its own output. Stored in Postgres, not a cloud secret manager (see `PROJECT.md` §6.1).
- **Zero-knowledge codebase, still**: everything above is local — router, worker, Postgres, Redis. Nothing leaves the machine except webhook payloads and PR/comment metadata.
- *(Future, once `PROJECT.md` §2.2's cloud engine exists)*: board/SCM API keys move into Google Cloud Secret Manager; the daemon authenticates to the cloud via a bearer token + device hardware ID (`PROJECT.md` §6.2).

## Extensibility

PM boards plug in via an agnostic `PMProvider` interface (verify webhook, get/list/move work items, comment) — see `PROJECT.md` §7. This mirrors the manifest/registry-based provider-abstraction pattern used by the reference project, **[Cascade](https://github.com/mongrel-intelligence/cascade)** (sibling directory, symlinked here as `cascade`), which the MVP copies directly rather than merely drawing inspiration from. GitHub Projects is the only concrete provider for the MVP; the interface exists so a second one (Trello, JIRA, Linear, Asana, …) could be added later without touching router/worker dispatch code.

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
- `swarm worktrees prune [--project <id>] [--dry-run]` (a.k.a. `npm run worktrees:prune`) — reclaims stale `task-<id>` worktrees under `.swarm-workspaces/` that are no longer in use and have no uncommitted changes.

It manages only the containerized stack — the worker still runs on the host (`npm run dev:worker`). Run it from source with `npm run swarm -- <command>`, or `npm run build` and invoke the `swarm` bin directly.

The worker isn't containerized because it provisions Git worktrees and spawns the `claude` / `antigravity` CLIs — those need the developer's own PATH, authentication, and config, which a container wouldn't have. Running it on the host is the local-first fit. It connects to the Compose Redis/Postgres over their published host ports (`REDIS_URL` / `DATABASE_URL` in `.env`), so **`git` and the `claude` / `antigravity` CLIs must be installed and authenticated on your machine** for the worker to get past provision/spawn.

The Postgres schema (project config + credentials at rest) is defined with **Drizzle** in `src/db/` — `npm run db:generate` regenerates migrations from the schema, `npm run db:migrate` applies them. Credentials are encrypted with AES-256-GCM before storage when `CREDENTIAL_MASTER_KEY` is set (plaintext otherwise, for local dev).

SWARM's host ports are offset from Cascade's defaults (router `3100` vs `3000`, dashboard `3101` vs `3001`, Postgres `5433` vs `5432`, Redis `6380` vs `6379`) so both stacks can run in parallel without a host-port clash — the compose project name is fixed to `swarm`, giving it its own network and volumes. Override any of them via `ROUTER_PORT` / `DASHBOARD_PORT` / `POSTGRES_PORT` / `REDIS_PORT` in `.env`.

The router exposes a health check at `http://localhost:${ROUTER_PORT:-3100}/health`; the dashboard exposes one at `http://localhost:${DASHBOARD_PORT:-3101}/health` plus a tRPC endpoint at `/trpc`. The router's webhook receiver (`POST /github/webhook`) verifies HMAC signatures, resolves the project, and applies a loop-prevention drop gate (SWARM-9) for both repo-scoped SCM events and the GitHub Projects board event, then hands off to the job queue. From there, a trigger registry dispatches each event to the pipeline phase it names — see [Pipeline phases](#pipeline-phases) above for what each phase does, and [Status](#status) below for the implementation detail behind the queue, trigger registry, and dedup/retry logic.

To let GitHub reach this local router with webhooks, expose it over a public HTTPS URL with a Cloudflare Tunnel — see **[`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md)** for the setup (a quick ephemeral tunnel for dev, a CLI-managed named tunnel for a stable URL, or a dashboard-created tunnel run as an opt-in `cloudflared` service in `docker-compose.yml` so it starts with the rest of the stack) and the GitHub webhook configuration.

## Configuration

SWARM's configuration splits into two layers:

- **General settings** — process/host-level knobs, set as **environment variables** (usually in `.env`, sourced from `.env.docker.example`). No schema; read directly where needed. These configure the router, worker, dashboard, database, Redis, credential encryption, and logging.
- **Project config** — the **per-project** shape (`swarm.config.json`, one entry per project), validated by a Zod schema (`src/config/schema.ts` — the single source of truth) and loaded into Postgres via `swarm config apply` / `npm run db:seed`. This is where a project's repo, worktree layout, board mapping, credential references, and per-phase agent/pipeline behaviour live.

> **This section is the canonical, human-editable catalogue of every configuration option.** It is meant to be kept in lock-step with the code (see [`ai/RULES.md` §7](./ai/RULES.md)): when an option is added, removed, renamed, or its default changes, update the matching row here in the same change. When you'd rather not click through the dashboard UI, point an agent at this section and ask it to change a setting — everything editable is listed here with the exact key, default, and file it lives in.

### General settings (environment variables)

Grouped by concern. "Required" means startup throws if it's unset; everything else has a default or a safe fallback. Docker-side ports (`POSTGRES_PORT`, `REDIS_PORT`, `ROUTER_PORT`, …) are the **host-published** ports; inside the Compose network the services use their own fixed container ports.

**Database (Postgres)** — `src/db/client.ts`
| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | _(unset)_ | Full Postgres connection string. If set, used verbatim and the `SWARM_POSTGRES_*` fallbacks are ignored. If neither this nor `SWARM_POSTGRES_HOST` is set, startup throws. |
| `SWARM_POSTGRES_HOST` | _(unset)_ | Host used to assemble a connection string when `DATABASE_URL` is absent. |
| `SWARM_POSTGRES_PORT` | `5432` | Port for the assembled connection string (container-internal; the host port is `POSTGRES_PORT`). |
| `SWARM_POSTGRES_USER` | `swarm` | DB user for the assembled connection string. |
| `SWARM_POSTGRES_PASSWORD` | `` (empty) | DB password for the assembled connection string. |
| `SWARM_POSTGRES_DB` | `swarm` | Database name for the assembled connection string. |
| `DATABASE_SSL` | SSL on | The literal `false` disables TLS; any other value keeps TLS on with `rejectUnauthorized: true`. |
| `DATABASE_CA_CERT` | _(unset)_ | Path to a CA cert file for the DB TLS connection; startup throws if the path doesn't exist. |

**Queue & worker (Redis / BullMQ)**
| Variable | Default | Purpose |
| --- | --- | --- |
| `REDIS_URL` | **required** | Redis connection URL for the BullMQ queue and all Redis-backed dedup (`src/lib/redis.ts`). Parsed for host, port (default `6379`), and password. |
| `SWARM_WORKER_CONCURRENCY` | `1` | How many jobs the worker runs at once (`src/worker/index.ts`). Must be a positive integer or startup throws. |
| `SWARM_WORKER_LOCK_DURATION_MS` | `300000` (5m) | BullMQ job-lock duration (`src/worker/index.ts`). The lock is renewed at ~half this interval while a phase runs, so it only has to exceed the worst-case event-loop stall between renewals — well above BullMQ's 30s default, so a brief CPU/GC/Redis hiccup can't get an in-flight run reclaimed as stalled (and, with `maxStalledCount: 0`, failed with no retry). Must be a positive integer or startup throws. |
| `SWARM_WORKTREE_SWEEP_INTERVAL_MS` | `3600000` (1h) | How often the worker runs the background worktree retention sweep (`src/worker/index.ts`). Must be a positive integer or startup throws. |

**Credential encryption at rest** — `src/db/crypto.ts`
| Variable | Default | Purpose |
| --- | --- | --- |
| `CREDENTIAL_MASTER_KEY` | _(unset → plaintext)_ | 64-char (32-byte) hex AES-256-GCM key for encrypting `project_credentials`. If unset, secrets are stored **plaintext** (dev only). Validated for length and hex format. |

**Dashboard API** — `src/dashboard.ts`
| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_TOKEN` | **required** | Shared-secret bearer token required on every `/trpc/*` request (`/health` is exempt). Startup throws if unset. |
| `DASHBOARD_PORT` | `3101` | Port the dashboard listens on (bound to `127.0.0.1` only). |

**Router** — `src/router/index.ts`
| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Webhook-receiver port **inside the router container**; the host-published port is `ROUTER_PORT`. |

**Logging** — `src/lib/logger.ts`
| Variable | Default | Purpose |
| --- | --- | --- |
| `SWARM_LOG_LEVEL` | `info` | Minimum level emitted: `debug` \| `info` \| `warn` \| `error`. |
| `SWARM_LOG_FORMAT` | auto | `json` or `pretty`. Auto-selects `pretty` on a TTY, `json` when piped. |
| `SWARM_LOG_FILE` | `logs/worker.log` (worker) | The worker tees its log lines (always JSON) to this file, in addition to stdout, so an unattended run leaves a greppable record. Set to override the path; relative paths resolve against the repo root (`logs/` is git-ignored). Other processes don't write a log file unless wired to. |
| `NO_COLOR` | _(unset)_ | Any value disables ANSI colour in `pretty` mode. |

**Host / Docker Compose ports** — `docker-compose.yml`, `.env.docker.example`
| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_PORT` | `5433` | Host port the Compose Postgres is published on. |
| `REDIS_PORT` | `6380` | Host port the Compose Redis is published on. |
| `ROUTER_PORT` | `3100` | Host port the Compose router is published on; also where `swarm status` probes `/health`. |
| `CLOUDFLARE_TUNNEL_TOKEN` | _(unset)_ | Token for the opt-in `cloudflared` Compose service (see `docs/cloudflare-tunnel.md`). |
| `COMPOSE_PROFILES` | _(unset)_ | Compose profiles to activate, e.g. `tunnel` to bring up `cloudflared`. |

**Credential secret values** (referenced by project config, not config themselves): the env vars a project's `credentials` block *points at* — by default `GITHUB_TOKEN_IMPLEMENTER`, `GITHUB_TOKEN_REVIEWER`, `GITHUB_WEBHOOK_SECRET`. `swarm config apply` reads these from the environment and stores them (encrypted) in Postgres. An unset reference is warned-and-skipped, not fatal.

**Web frontend (Vite)** — only `VITE_`-prefixed vars reach the browser (`web/.env`)
| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_DASHBOARD_TOKEN` | _(unset)_ | Must equal the backend `DASHBOARD_TOKEN`; sent as the `Authorization: Bearer` header. |
| `VITE_API_URL` | `` (same-origin) | Base URL for the dashboard API. |

### Project config (`swarm.config.json`)

The file is `{ "projects": [ … ] }` — a non-empty array of project objects. Source of truth: `src/config/schema.ts` (+ `src/integrations/pm/github-projects/config-schema.ts`). Edit the file, then run `swarm config apply` (or `npm run db:seed`) to load it into Postgres — the running router/worker resolve config from the DB, not the file.

**Top-level project fields** — `ProjectConfigSchema`
| Field | Required / Default | Purpose |
| --- | --- | --- |
| `id` | **required** | Stable internal project id; one Postgres row per project. |
| `name` | **required** | Human-facing name; also `{project-name}` in worktree paths. |
| `repo` | **required** | GitHub repo as `owner/repo`. |
| `repoRoot` | **required** | Absolute path to the main repo checkout on the dev machine. |
| `worktreeRoot` | `.swarm-workspaces` | Directory under `repoRoot` for per-task git worktrees. |
| `baseBranch` | `main` | Branch worktrees are cut from and PRs target. |
| `branchPrefix` | `issue-` | Prefix for task branch names (`issue-<n>-<slug>`). |
| `pm` | `{ type: "github-projects" }` | PM provider discriminator (only `github-projects` exists today). |
| `githubProjects` | **required** | GitHub Projects board mapping (below). |
| `credentials` | **required** | References (env-var keys) to GitHub credentials — never the secrets. |
| `agents` | optional | Per-phase agent CLI/model overrides (below). |
| `pipeline` | optional | Per-phase autonomous board-move control (below). |
| `worktreeRetention` | optional | Retention sweep tuning — `{ maxWorktrees }`, default `10`; how many of the project's most-recently-active `task-<id>` worktrees to keep (`src/config/schema.ts`'s `WorktreeRetentionConfigSchema`). |

**`credentials`** — all three are *references* (keys into the secret store / env-var names), never raw tokens; each required:
| Field | Purpose |
| --- | --- |
| `implementer` | Reference to the implementer-persona GitHub token. |
| `reviewer` | Reference to the reviewer-persona GitHub token. |
| `webhookSecret` | Reference to the GitHub webhook HMAC secret. |

**`githubProjects`** — `githubProjectsConfigSchema`
| Field | Required / Default | Purpose |
| --- | --- | --- |
| `projectId` | **required** | Projects v2 board node id (e.g. `PVT_…`). |
| `statusFieldId` | **required** | Node id of the single-select "Status" field. |
| `statusOptions` | **required** | Map of SWARM pipeline status keys (`backlog`, `planning`, `todo`, `inProgress`, `inReview`, `done`) → the Status field's single-select option ids. |
| `phaseLabels` | optional | Map of SWARM phase keys (`phase-0`…) → repo label names. |

**`agents`** — per-phase overrides; every phase key is optional, omit to keep the phase's coded default. Phases: `planning`, `implementation`, `review`, `respondToReview`, `respondToCi`. Each is an object:
| Field | Purpose |
| --- | --- |
| `cli` | `claude`, `antigravity`, or `codex`. Omit to keep the phase's coded-default CLI. |
| `model` | Model string; must be valid for the chosen `cli` per `src/harness/models.ts` (Claude: `fable`/`opus`/`sonnet`/`haiku`; Antigravity: the exact `agy models` display strings; Codex: `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`/`gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`). Omit for the CLI's default model. |

**`pipeline`** — controls whether a phase moves the board item itself on completion, and whether Planning may split a too-large task. Only `planning` and `implementation` are configurable (the other phases are SCM-event-driven and never move a card):
| Field | Default | Purpose |
| --- | --- | --- |
| `pipeline.planning.autoAdvance` | `false` | If true, Planning moves the item to "ToDo" after posting the plan; otherwise a human moves it after reviewing. Always forced off for a spawned `swarm:split-child` item. |
| `pipeline.planning.autoSplit` | `true` | If true, Planning may decompose a task it judges too large into smaller sibling items (the original becomes the first task; siblings are created in "Planning", labelled `swarm:split-child`, and never auto-advance). Set false to always plan an item as a single task. |
| `pipeline.implementation.autoAdvance` | `true` | If true, Implementation moves the item to "In review" once the PR is opened. (Its pickup move to "In progress" is unconditional either way.) |

### Editable via the dashboard UI

Today the web dashboard exposes only a **subset**: creating a project (`id`, `name`, `repo`, `repoRoot`) and deleting one. The board mapping (`githubProjects`), `credentials`, `agents`, `pipeline`, and all general/env settings are **not** yet editable in the UI — change those in `swarm.config.json` / `.env` and re-apply. Broader per-project settings screens and credentials management are on the phase-6 backlog (see [Status](#status)).

## Status

Early implementation. Summary by area:

### Toolchain & persistence
- Node.js/TypeScript toolchain scaffolded: strict TS + ESM, `@/*` alias, Biome, Vitest, Lefthook, commitlint; `npm run verify` runs lint + typecheck + tests.
- Postgres persistence layer in place: Drizzle schema + migrations for project config, encrypted-at-rest credentials, and agent-run history.

### GitHub SCM layer
- Dual-persona (`implementer`/`reviewer`) credential scoping via `AsyncLocalStorage`, with per-persona token resolution from Postgres.
- A router adapter parses inbound webhooks, resolves the project, and enforces loop prevention.
- The router serves the HTTP webhook receiver: HMAC-SHA256 signature verification on `POST /github/webhook`, feeding the adapter through to an enqueue seam that shapes each verified event into a `SwarmJob` and pushes it onto the `swarm-jobs` BullMQ queue via the producer (SWARM-35).

### PM (GitHub Projects) integration
- The `projects_v2_item` board webhook is routed (SWARM's `pm:status-changed` ingress): a PM router adapter resolves the SWARM project by board node ID, filters to Status-field edits, and maps Status options to pipeline phases in a provider-agnostic way.
- The PM provider self-registers through a manifest + registry loaded from a single canonical entrypoint (`src/integrations/entrypoint.ts`), so the receiver resolves its adapter by id rather than hardcoding it (SWARM-13).
- The concrete GitHub Projects `PMProvider` (`src/integrations/pm/github-projects/provider.ts` — GraphQL item read/move plus linked-Issue comments) backs the two board-driven phases.

### Worker & pipeline phases
- The BullMQ job consumer (SWARM-17) resolves each dequeued job through a Cascade-style trigger registry (`src/triggers/`, SWARM-53) and dispatches the matched trigger to its pipeline phase; the consumer resolves the phase, hands off to the orchestrator, and maps its result to the job outcome.
- Shared building blocks (`src/pipeline/`): per-task worktree lifecycle (`GitWorktreeManager`, `src/worker/git-worktree-manager.ts`, SWARM-14 — provisions an isolated worktree under `.swarm-workspaces/task-<id>/`, with a detached-HEAD mode for read-only phases), environment grafting (`graftEnvironment`, `src/worktree/graft.ts`, SWARM-15 — symlinks `node_modules`/`.env`/caches into it), and the agent-CLI execution engine (`src/harness/agent-cli.ts`, SWARM-16 — spawns `claude`/`antigravity`/`codex` with the worktree as CWD).
- All five phases are wired into the trigger registry:
  - **Planning** (SWARM-18) — detached worktree → Claude Code writes `proposed_plan.md` → posted on the linked Issue → moves the item to "ToDo" itself only if `pipeline.planning.autoAdvance` is on (default off).
  - **Implementation** (SWARM-19) — task-branch worktree → Claude Code implements, pushes, opens the PR via `gh` → PR linked on the item → moves it to "In review" if `pipeline.implementation.autoAdvance` is on (default on). Either phase's agent CLI/model can be overridden per project via `swarm.config.json`'s `agents` block (`src/harness/models.ts`).
  - **Review** (SWARM-20) — detached worktree at the PR's head SHA → Claude Code as the *reviewer* persona (via `GH_TOKEN`) reads the diff and submits a formal `gh pr review`.
  - **Respond-to-review** (SWARM-21) — worktree on the PR's existing task branch → Claude Code as the implementer addresses the batched review point by point (fixing valid nits and pushing, or pushing back with a rationale), always replying — even a plain thank-you — so a human can see the response ran.
  - **Respond-to-CI** (SWARM-64) — worktree on that same task branch → Claude Code as the implementer fixes a *failing* check suite, pushing a surgical fix or reporting no change was warranted.
- Dispatch: a single **status-change handler** (`src/triggers/handlers/pm-status.ts`) re-reads the board item authoritatively and starts Planning or Implementation by the card's Status; **PR-lifecycle handlers** start Review (on a non-draft, same-repo, SWARM-authored PR opening or its checks passing) and Respond-to-review (on the reviewer persona submitting any review — approve, comment, or changes-requested).
- An author-persona gate reviews only PRs a SWARM persona opened (Cascade's default `authorMode='own'`), checked before the `check_suite` aggregate query so a PR we'd never review doesn't cost an Actions-API call.
- On `check_suite` completion, the `pr-review` handler aggregates *every* check on the head SHA (via the Actions API) rather than trusting the single suite's own conclusion — reviewing, routing a failed suite to Respond-to-CI, or deferring with a coalesced ~30s recheck (`scheduleCoalescedJob`, #63) when the Actions API lags webhook delivery.
- A cross-process dedup claim (`src/triggers/review-dispatch-dedup.ts`, SWARM-62) — a Redis `SET NX EX` keyed on `owner/repo:pr:headSha`, failing closed if Redis is down — ensures a PR that opens *and* then passes its checks is acted on once per commit, not once per event. The respond-to-ci path shares that slot and adds a per-PR fix-attempt cap (`src/triggers/respond-to-ci-attempts.ts`) so a fix that never makes CI green can't loop forever.
- Revised from live end-to-end testing:
  - Planning no longer moves the item at all — a human reviews the plan and moves it to "ToDo" themselves.
  - Implementation triggers on "ToDo" rather than "In progress" — the phase itself moves the item to "In progress" as a status report once it picks up the task, not as the trigger (`src/pm/pipeline.ts`).
  - The Board view's drag-and-drop fires a `reordered` action with no field-value data, not `edited` as originally assumed — the router/trigger now accept `reordered` too, guarded by a Redis-backed dedup (`pm-status-dedup.ts`) against the harmless within-column reorders it also fires on.

### Worker resilience & queue
- A usage/session-limit hit from the agent CLI (`classifyAgentFailure`, `src/harness/agent-failure.ts`) doesn't fail the job outright — it's deferred and re-enqueued once the CLI's own reported reset time passes (SWARM-91).
- That same defer-and-retry path also covers a run the *worker itself* killed (a dev `--watch` restart, a deploy, a graceful shutdown mid-phase) — previously indistinguishable from an unexplained agent crash, since an aborted `claude`/`agy` process can exit with empty output and no OS-reported signal. Both cases share one capped retry budget, with the retry delay floored above the review-dispatch-dedup TTL so it can't collide with a claim the interrupted run may have already taken.
- Agent runs that stall (`stalled` kind, e.g. "timeout waiting for response") or timeout are terminal failures. For PM-driven phases (planning/implementation), `reportPhaseFailureToBoard` appends a splitting suggestion to the failure comment, advising that the task's scope may be too large and should be split by hand.
- Job-priority split: PR review-lifecycle jobs (`pull_request`/`pull_request_review`/`check_suite`) always dequeue ahead of PM-board jobs (`projects_v2_item`, which drive Planning/Implementation), via `src/queue/producer.ts`'s `priorityFor`.
- Worker concurrency is configurable (`SWARM_WORKER_CONCURRENCY`, default 1) instead of hardcoded to one job at a time.

### Cross-cutting
- One shared structured logger (`src/lib/logger.ts`, SWARM-23) emits JSON log lines (level, ISO timestamp, message, context) for machine parsing, with a `pretty` mode for local dev and a `SWARM_LOG_LEVEL` filter; the router and worker each tag their lines with a `component`.
- Antigravity's actual binary is `agy`, and its `-p`/`--print` flag — unlike Claude's, which is a bare boolean — takes the prompt as its own value: it must be the last flag before the prompt, or it silently swallows whatever comes next as the "prompt" instead (confirmed live: a real Implementation run answered a question about `--dangerously-skip-permissions` instead of doing the task). See the `DEFAULT_ARGS`/`PRINT_FLAG` comment in `src/harness/agent-cli.ts` and `ai/RULES.md` §6.

### Web dashboard (phase-6 backlog)
- Host-run, same model as the worker. API scaffold in place: Hono + tRPC entrypoint (`src/dashboard.ts`, SWARM-75) and its localhost-bound bearer-token auth guard (SWARM-76).
- `projectsRepository` has full CRUD primitives (SWARM-77); a `projects` tRPC router (list/getById/create/update/delete, SWARM-78) is implemented and up for review, not yet merged into `appRouter`.
- `runsRepository` has full CRUD, upsert, and pagination primitives for agent-run history (SWARM-102), ready for future dashboard API/UI integration.
- A `web/` scaffold (Vite + React, TanStack Router/Query, a tRPC client, Tailwind and the `ai/DESIGN_SYSTEM.md` tokens, SWARM-81) is merged; the first real screen (projects list + create dialog, SWARM-82) is implemented.
- Still backlog: credentials management (SWARM-79/80), and the remaining per-project settings screens (SWARM-83–87).

### Board & roadmap
MVP scope and the active backlog live on the **[GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1)** — org-owned, since a user-owned board (the original location) can't receive the `projects_v2_item` webhook event the Status-changed trigger needs (see `ai/RULES.md` §5 for ids/field details; `KANBAN_BOARD.md` is retired). `PROJECT.md` §8 has the original longer-term roadmap; the MVP path diverges from it as noted throughout this section.

## Contributing

Agent/contributor conventions (including GitHub workflow rules) live in **[`ai/RULES.md`](./ai/RULES.md)** — read it before making changes.
