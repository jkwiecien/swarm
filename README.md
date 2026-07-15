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
   — validates agent hand-offs → deterministic commit/push/PR/review/comment delivery → board update

Dashboard  (Hono + tRPC, host process, 127.0.0.1-only)
   — self-hosted config/credentials API; a web/ frontend is in progress (see "Status")
```

- **Router**: Node.js/TypeScript, Hono — verifies GitHub webhook signatures, resolves the project, enqueues jobs.
- **Queue**: BullMQ on Redis — retries, backoff, configurable worker-global concurrency (`SWARM_WORKER_CONCURRENCY`, default 1), and a per-project `maxConcurrentJobs` cap. Over-limit jobs are deferred. PR review-lifecycle jobs (`pull_request`/`pull_request_review`/`check_suite`) always queue ahead of PM-board jobs (`projects_v2_item`, which drive Planning/Implementation) regardless of those limits, so a review never sits behind a multi-minute implementation run (`src/queue/producer.ts`'s `priorityFor`).
- **Worker**: drives the worktree + harness lifecycle, invokes `claude` / `antigravity` / `codex`, streams their stdout/stderr, pushes and opens PRs. Runs on the host (not containerized) so the agent CLIs have the developer's PATH/auth/config.
- **Agent session resume**: a rate-limited or genuinely timed-out run — in **any** phase, on **any** CLI — is deferred with its worktree preserved and resumed on retry, continuing the same agent session instead of redoing its work (`claude --resume`, `agy --conversation <id>`, `codex exec resume <id>`). The session id is captured per CLI (claude/codex report it in their output; Antigravity's is recovered from its conversation store, `src/harness/antigravity-session.ts`), and retention pins the checkout until the retry runs. A run whose session wasn't captured, or whose checkout was pruned, falls back to a fresh invocation.
- **Dashboard**: self-hosted config/credentials API, also host-run — see "Running the stack" below.
- **Postgres**: project config, credentials, run history.
- Router, Redis, and Postgres run in one Docker Compose stack; the worker and dashboard run alongside on the host — one machine either way, see `PROJECT.md` §2.1 and `ai/ARCHITECTURE.md`.

The original cloud-engine design (Cloud Run + Pub/Sub + Firestore + a gRPC-connected daemon) is deferred — see `PROJECT.md` §2.2/§3 for that design once it's revisited.

## Pipeline phases

Each phase's agent CLI, model, and reasoning level are configurable per project, per phase, via `swarm.config.json`'s `agents` block (`src/harness/models.ts` is the catalog of valid `cli`/`model` combinations and the reasoning levels each model supports) — the descriptions below are the code's own defaults when a project doesn't override them. Planning and Implementation are the only two phases that move the board's Status themselves, and each does so conditionally on an `autoAdvance` setting (also per-phase, in `swarm.config.json`'s `pipeline` block): Planning defaults to **off** (a human reviews the plan and moves it to "ToDo" themselves), Implementation defaults to **on** (moves straight to "In review" once the PR is up).

Worker-spawned agents are scoped to exactly one phase. Their prompts prohibit the manual `solve-issue` skill, arbitrary subagents/skills, and continuing into another phase; the worker owns every phase hand-off and supplies the correct persona and worktree. Curated delegation is SWARM-orchestrated, not a CLI subagent: an opted-in phase writes a validated, exact-path delegation contract and runs `swarm delegate`, which launches a lighter-model **child run** in the same worktree (Claude confined to Read/Edit via `--permission-mode acceptEdits` — no shell, so no git/commit/nested delegation; Codex under the `--sandbox workspace-write` policy), pinned to the child model, wall-clock-bounded, with no ability to delegate again. SWARM enforces the contract's `allowedPaths` against what the child actually touched (out-of-scope changes are reverted and rejected), the child cannot commit/push or perform GitHub/board operations, and the primary must inspect and accept or rework every completed child. The same path serves Claude and Codex today (Antigravity is unsupported, #185). The manual skill remains available for explicitly requested interactive sessions outside the worker.

1. **Planning** (Claude Code by default) — item moves to "Planning" → the worker provisions a detached worktree, the planning agent reads the code graph and writes `proposed_plan.md` → plan is posted back to the board. Moves the item to "ToDo" itself if `autoAdvance` is on for this project; otherwise a human moves it once they've reviewed the plan. If `autoSplit` is on (default) and the agent judges the item too large for a single PR, it **splits** it: the original item becomes the smaller first task (re-scoped, possibly renamed), and the rest is spawned as sibling items — each created in "Planning" so it gets planned on its own, tagged `swarm:split-child` so it never auto-advances, and carrying a comment explaining the split. A human moves those siblings to "ToDo" in the order they choose.
2. **Implementation** (Claude Code by default) — item moves to "ToDo" → the phase reports the pickup by moving the item to "In progress" → the agent implements and verifies the change, then writes a structured hand-off. SWARM validates the prepared tree, commits and pushes it under the implementer persona, reuses or creates the PR, links it back to the board, and moves the item to "In review" when `autoAdvance` is on.
3. **Review** (Claude Code, reviewer persona) — PR opened / checks pass → the agent writes a structured verdict and review body; SWARM submits the formal review under the reviewer persona.
4. **Respond to Review** (Claude Code, implementer persona) — the agent processes the review and leaves fixes plus a structured reply; SWARM commits/pushes any fix and posts one idempotent response comment.
5. **Respond to CI** (Claude Code, implementer persona) — the agent diagnoses CI and leaves a surgical fix or no-fix decision; SWARM performs any commit/push and posts the explanation. A per-PR attempt cap stops a fix that never turns CI green from looping forever.
6. **Resolve Conflicts** (Claude Code, implementer persona) — the agent resolves conflicting intent and leaves the verified tree; SWARM rechecks the observed remote head, creates the normal merge commit, pushes without force, and posts the result.

Deterministic delivery uses durable operation identities and a step-progress sidecar in the retained worktree. Equivalent PRs, reviews, and comments are detected and reused, so a failed delivery step can resume without duplicating already-completed external mutations.

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
`swarm start`, `npm run dev:dashboard`, `npm run dev:worker`, and their production
start variants apply pending committed migrations before serving requests or processing
jobs. The worker also applies them **in-process on every (re)start** — the npm-script
prefix runs only on the first invocation, but `tsx --watch` restarts the node process on
each source change (frequent, since SWARM edits its own repo), so without the in-process
step a restart onto newer schema-referencing code would run ahead of the DB and silently
fail every run-history write (the phase runs but never appears in the dashboard). A
schema-mismatched worker refuses to start. The explicit `npm run db:migrate` step remains
useful for setup and maintenance, and is safe to run repeatedly.

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

SWARM's configuration splits into three layers:

- **General settings** — process/host-level knobs, set as **environment variables** (usually in `.env`, sourced from `.env.docker.example`). No schema; read directly where needed. These configure the router, worker, dashboard, database, Redis, credential encryption, and logging.
- **Project config** — the **per-project** shape (`swarm.config.json`, one entry per project), validated by a Zod schema (`src/config/schema.ts` — the single source of truth) and loaded into Postgres via `swarm config apply` / `npm run db:seed`. This is where a project's repo, worktree layout, board mapping, credential references, and per-phase agent/pipeline behaviour live.
- **Global settings** — **app-wide** knobs that apply across every project, validated by a Zod schema (`src/config/app-settings.ts` — the single source of truth) and stored **DB-first** in the single-row `app_settings` table. Unlike project config these are *not* file-sourced; they're edited through the dashboard API (the `settings` tRPC router), and when nothing is stored the coded defaults apply. Today the only global setting is `agents.defaults` (the global per-CLI default model).

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
| `SWARM_WORKER_CONCURRENCY` | `1` | Worker-global maximum number of jobs running at once (`src/worker/index.ts`). Must be a positive integer or startup throws. Each project's `maxConcurrentJobs` additionally caps that project's in-flight jobs, so its effective limit is the smaller of the two values. |
| `SWARM_WORKER_LOCK_DURATION_MS` | `300000` (5m) | BullMQ job-lock duration (`src/worker/index.ts`). The lock is renewed at ~half this interval while a phase runs, so it only has to exceed the worst-case event-loop stall between renewals — well above BullMQ's 30s default, so a brief CPU/GC/Redis hiccup can't get an in-flight run reclaimed as stalled (and, with `maxStalledCount: 0`, failed with no retry). Must be a positive integer or startup throws. |
| `SWARM_WORKTREE_SWEEP_INTERVAL_MS` | `3600000` (1h) | How often the worker runs the background worktree retention sweep (`src/worker/index.ts`). Must be a positive integer or startup throws. |
| `SWARM_AGENT_TIMEOUT_MS` | `1800000` (30m) | Default wall-clock timeout applied to **every** phase/agent run when the project sets no per-phase `agents.<phase>.timeoutMs` (`src/worker/consumer.ts`). The harness kills a run that exceeds it (SIGTERM, then SIGKILL after a 5s grace) so a hung agent can't hold a worker slot indefinitely. A genuinely-interrupted timeout is then **deferred and resumed** (the agent continues its prior CLI session in the preserved worktree — see the "Agent session resume" bullet under [Architecture at a glance](#architecture-at-a-glance-mvp)), bounded by the same retry cap as a rate-limit; only a run that trapped SIGTERM and still exited 0 is finalized `failed`. A per-phase `timeoutMs` in `swarm.config.json` overrides it. Must be a positive integer or startup throws. |
| `SWARM_DELEGATION_ENABLED` | `true` | Global emergency switch for curated semantic delegation. The literal `false` disables it for every project/phase; projects remain opted out unless `agents.delegation.enabled` and a phase flag are also true. |
| `SWARM_DELEGATE_COMMAND` | `swarm delegate` | The command a primary agent runs to delegate — SWARM injects it into the phase env so the prompt can reference `$SWARM_DELEGATE_COMMAND`. Override when `swarm` isn't on the agent's `PATH` (e.g. `node /abs/path/bin/swarm.js delegate`). |
| `SWARM_DELEGATION_CHILD_TIMEOUT_MS` | `600000` (10m) | Wall-clock bound for a curated delegation child run (`swarm delegate`). Neither `claude` nor `codex` exposes a turn-count limit, so the child is time-bounded; it is killed (SIGTERM) past this. Must be a positive integer, else the default applies. |
| `SWARM_STALE_RUN_SWEEP_INTERVAL_MS` | `300000` (5m) | How often the worker sweeps for stale `running` run-history rows while it keeps serving jobs — a phase whose process died without finalizing (`src/worker/index.ts`). A row still `running` past `max(configured timeout) + 10m` grace is reconciled to `failed`. Must be a positive integer or startup throws. |
| `SWARM_ANTIGRAVITY_CONVERSATIONS_DIR` | `~/.gemini/antigravity-cli/conversations` | Where the harness looks for Antigravity's per-conversation `.db` files to capture the id of the session an `agy` run created, so a deferred run can be resumed with `agy --conversation <id>` (`src/harness/antigravity-session.ts`). `claude` and `codex` report their session id directly, so this applies only to Antigravity; override for a non-default `agy` install or in tests. |

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
| `maxConcurrentJobs` | `1` | Maximum jobs this project may run concurrently (positive integer). The worker enforces it at runtime and defers over-limit jobs through the bounded `phase-deferred` retry path. Its effective limit is `min(SWARM_WORKER_CONCURRENCY, maxConcurrentJobs)`. |
| `pm` | `{ type: "github-projects" }` | PM provider discriminator (only `github-projects` exists today). |
| `githubProjects` | **required** | GitHub Projects board mapping (below). |
| `credentials` | **required** | References (env-var keys) to GitHub credentials — never the secrets. |
| `agents` | optional | Per-phase agent CLI/model overrides (below). |
| `pipeline` | optional | Per-phase autonomous board-move and PR-merge control (below). |
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

**`agents`** — per-phase overrides and per-CLI defaults. Every key is optional.
- **`defaults`** — optional map of `cli` -> default `model` override for the whole project. This is the tier above the **global** `agents.defaults` (see [Global settings](#global-settings-app_settings)). Defaults store a **model only**, never a reasoning level (a per-CLI default reasoning can be invalid for another model — see the `reasoning` field below).
- **`delegation`** — optional curated semantic-delegation policy (SWARM-orchestrated child runs). It is off unless `enabled: true`; `lightModels` optionally pins the lighter child model per CLI (`{ claude, codex }`, defaulting to Claude→`haiku`, Codex→`gpt-5.4-mini`); `minimumSemanticOperations` defaults to `3` and cannot be lower; and `phases` is a boolean map using the phase keys below (default `{ implementation: true }`). Both this project policy and the global environment switch (`SWARM_DELEGATION_ENABLED`) must allow the phase, and the phase's CLI must be child-capable (Claude or Codex; Antigravity is unsupported, #185). No `.claude/agents` definitions are needed — the child is launched and enforced by SWARM (`swarm delegate`), not a CLI native subagent.
- **Phases** — `planning`, `implementation`, `review`, `respondToReview`, `respondToCi`, `resolveConflicts`. Each is an object:
  | Field | Purpose |
  | --- | --- |
  | `cli` | `claude`, `antigravity`, or `codex`. Omit to keep the phase's coded-default CLI. |
  | `model` | Logical model id; must be valid for the chosen `cli` per `src/harness/models.ts` (Claude: `fable`/`opus`/`sonnet`/`haiku`, defaults to `sonnet`; Antigravity logical ids: `gemini-3.5-flash`/`gemini-3.1-pro`/`claude-sonnet-4.6`/`claude-opus-4.6`/`gpt-oss-120b`, defaults to `gemini-3.5-flash` — reasoning is chosen separately via `reasoning`, not baked into the model string; Codex: `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`/`gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`, defaults to `gpt-5.6-terra`). A pre-#180 config that stored an antigravity combined string (`"Gemini 3.5 Flash (High)"`) is migrated losslessly to the logical id plus its `reasoning` level on load. Omit to fall back to the project's `defaults[cli]`, then the global `defaults[cli]`, then the coded default. |
  | `reasoning` | Normalized reasoning level — one of `low`/`medium`/`high`/`xhigh`/`max` — mapped per CLI at launch: Claude `--effort <level>`, Codex `-c model_reasoning_effort="<level>"`, Antigravity folded into the combined `agy` model variant (no flag). Must be a level the chosen `(cli, model)` supports per the hand-maintained catalog in `src/harness/models.ts` (`reasoningChoices`), which encodes each model's cap — e.g. Codex `gpt-5.4-mini` tops out at `high`, GPT-5.5/5.4 at `xhigh`, the GPT-5.6 family at `max`; Claude Fable/Opus/Sonnet expose the full range (default `high`). A model with **no** reasoning control has an empty list and rejects any level: **Claude Haiku** (no `--effort` support — budget-based thinking only) and Antigravity single-variant models (e.g. `claude-sonnet-4.6` "Thinking", `gpt-oss-120b`). The dashboard shows the selector disabled ("N/A" for a no-reasoning model, "Fixed" for a single fixed variant). **Omit to keep the CLI/model's own default reasoning** (nothing is passed for Claude/Codex; Antigravity uses the model's default variant). Reasoning has **no per-CLI defaults tier** — a level valid for one model can be invalid for another, so it is resolved against the effective model (per-phase/per-run override → the model's own default), never as a free-standing per-CLI value. |
  | `timeoutMs` | Per-phase wall-clock run timeout in **milliseconds**, from 5 to 45 minutes inclusive. The dashboard displays and edits it in whole minutes, defaulting each phase to 30 minutes. Omit it in file config to fall back to `SWARM_AGENT_TIMEOUT_MS`. A run that exceeds it is killed and finalized as `failed` with `timedOut: true`. |
  | `prompt` | Optional project-owned custom prompt for this phase, appended to SWARM's built-in phase instructions as a clearly delimited "Project instructions" section (after the static instructions, before the task context). It **supplements** — never overrides or weakens — the phase guard, identity/auth guidance, hand-off contract, or phase scope. Trimmed on load; a whitespace-only value is treated as unset (adds nothing, so the effective prompt is exactly the default). Bounded to 10,000 characters (checked against the trimmed value). Edited per phase in the dashboard's **Agent Configuration → phase details** screen. Omit for the default behavior. |

**`pipeline`** — controls board movement/splitting for Planning and Implementation, whether SCM-event-driven phases run, and opt-in merging after a successful review response. Every field is optional. Review, Respond-to-review, and Respond-to-CI default to enabled when their setting or the whole `pipeline` block is omitted. Respond-to-review cannot be enabled unless Review is enabled:
| Field | Default | Purpose |
| --- | --- | --- |
| `pipeline.planning.autoAdvance` | `false` | If true, Planning moves the item to "ToDo" after posting the plan; otherwise a human moves it after reviewing. Always forced off for a spawned `swarm:split-child` item. |
| `pipeline.planning.autoSplit` | `true` | If true, Planning may decompose a task it judges too large into smaller sibling items (the original becomes the first task; siblings are created in "Planning", labelled `swarm:split-child`, and never auto-advance). Set false to always plan an item as a single task. |
| `pipeline.implementation.autoAdvance` | `true` | If true, Implementation moves the item to "In review" once the PR is opened. (Its pickup move to "In progress" is unconditional either way.) |
| `pipeline.review.enabled` | `true` | If false, Review events are skipped without dispatching the Review phase. |
| `pipeline.respondToReview.enabled` | `true` | If false, submitted reviews are skipped without dispatching Respond-to-review. Requires Review to be enabled. |
| `pipeline.respondToReview.skipOnMinors` | `true` | If true, only a reviewer-persona `changes_requested` verdict starts Respond-to-review; approvals and comment-only reviews are skipped. Set false to respond to every reviewer-persona verdict. |
| `pipeline.respondToReview.autoMerge` | `false` | If true, after the implementer fixes review findings or acknowledges a review with no findings, SWARM enables GitHub auto-merge. GitHub waits for required checks/reviews or uses the repository merge queue; pushbacks on concrete review points never enable it. An unavailable auto-merge is logged but does not fail the response. |
| `pipeline.respondToCi.enabled` | `true` | If false, failed-check events are skipped without dispatching Respond-to-CI. |

### Global settings (`app_settings`)

App-wide settings that apply across **every** project, as opposed to the per-project `swarm.config.json`. Source of truth: `src/config/app-settings.ts` (`AppSettingsSchema`). Stored **DB-first** as one jsonb blob in the single-row `app_settings` table (id `global`) and edited through the dashboard API (the `settings` tRPC router — `get`/`update`), **not** a config file — so there is nothing to `swarm config apply`. When no row exists the coded defaults apply, so no seeding is required for correct default behaviour. The blob is extensible: future global settings (host URL, worker concurrency, …) are added as sibling keys without a migration.

**`agents.defaults`** — the **global** per-CLI default model: a map of `cli` (`claude` / `antigravity` / `codex`) → default `model`, each validated for that CLI per `src/harness/models.ts` (same rules as the project-level `agents.defaults`).

The worker resolves the model for a phase through a four-tier fallback chain, most specific first (`resolveModel`, `src/worker/consumer.ts`):

1. the phase's own `model` (project `agents.<phase>.model`);
2. the **project** default — project `agents.defaults[cli]`;
3. the **global** default — `agents.defaults[cli]` from these settings;
4. the coded default — `DEFAULT_MODEL_PER_CLI[cli]` (`src/harness/models.ts`: Claude `sonnet`, Antigravity `gemini-3.5-flash`, Codex `gpt-5.6-terra`).

Reasoning (issue #180) is **not** part of this model chain: it is resolved separately from the per-phase/per-run reasoning override and otherwise inherits the effective model's own default (see the per-phase `reasoning` field above). The run row records the requested reasoning (or `Default` when omitted) alongside the model, and the manual "Retry now" dialog can override it — an override incompatible with a changed CLI/model is dropped rather than launched.

### Editable via the dashboard UI

Today the web dashboard exposes a **subset** of settings:

- **Projects** — create a project (`id`, `name`, `repo`, `repoRoot`) and delete one, plus per-project **General Settings** (`repo`, `repoRoot`, `worktreeRoot`, `baseBranch`, `branchPrefix`), **Agent Configuration** (a per-phase summary table where each row opens a phase-details screen for that phase's `cli`/`model`/`reasoning`/timeout, its enable toggle, a read-only summary of the fixed SWARM system prompt, and an optional custom `prompt` appended to it — plus the project-level `agents.defaults`), and the Respond-to-review auto-merge/minor-review controls.
- **Settings** — a top-level, app-wide **Settings** screen (sidebar → *Settings → General*) for [global settings](#global-settings-app_settings). Its only section today is **Default Agent Models** — the global per-CLI default model for Claude / Antigravity / Codex (writes `agents.defaults` via the `settings` tRPC router); leaving a CLI on its default option clears the global default so the coded default applies.

The board mapping (`githubProjects`), credentials, pipeline controls other than Respond-to-review auto-merge/minor-review handling, and all general/env settings are **not** yet editable in the UI — change those in `swarm.config.json` / `.env` and re-apply. Credentials management and further global-settings sections are on the phase-6 backlog (see [Status](#status)).

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
- All six phases are wired into the trigger registry:
  - **Planning** (SWARM-18) — detached worktree → Claude Code writes `proposed_plan.md` → posted on the linked Issue → moves the item to "ToDo" itself only if `pipeline.planning.autoAdvance` is on (default off).
  - **Implementation** (SWARM-19) — task-branch worktree → the agent implements/verifies and writes a structured hand-off → SWARM validates, commits, pushes, opens/reuses the PR, links it on the item, and optionally moves it to "In review". Either phase's agent CLI/model can be overridden per project via `swarm.config.json`'s `agents` block (`src/harness/models.ts`).
  - **Review** (SWARM-20) — detached worktree at the PR's head SHA → the reviewer agent writes a structured verdict → SWARM submits the formal review under the reviewer persona.
  - **Respond-to-review** (SWARM-21) — worktree on the existing task branch → the implementer addresses feedback and writes a structured response → SWARM commits/pushes any fix and posts the idempotent response.
  - **Respond-to-CI** (SWARM-64) — worktree on that same task branch → the implementer fixes a failing check or reports no change → SWARM commits/pushes and posts the explanation.
  - **Resolve Conflicts** — worktree on a confirmed-conflicting PR branch → the implementer merges the current base, resolves conflicts, runs relevant checks, commits and pushes normally. Mergeability-null rechecks are coalesced and bounded; dispatch is deduplicated per PR/head/base state.
- Dispatch: a single **status-change handler** (`src/triggers/handlers/pm-status.ts`) re-reads the board item authoritatively and starts Planning or Implementation by the card's Status; **PR-lifecycle handlers** start Review (on a non-draft, same-repo, SWARM-authored PR opening or its checks passing) and Respond-to-review (by default, only on the reviewer persona submitting `changes_requested`; `skipOnMinors: false` also dispatches approvals and comment-only reviews).
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
- A genuinely-interrupted wall-clock timeout is deferred and resumed on the same shared retry budget (see the "Agent session resume" bullet above); only a stall (`stalled` kind, e.g. "timeout waiting for response") or a timeout that still exited 0 (worktree already gone) is a terminal failure. For those terminal cases on PM-driven phases (planning/implementation), `reportPhaseFailureToBoard` appends a splitting suggestion to the failure comment, advising that the task's scope may be too large and should be split by hand.
- Job-priority split: PR review-lifecycle jobs (`pull_request`/`pull_request_review`/`check_suite`) always dequeue ahead of PM-board jobs (`projects_v2_item`, which drive Planning/Implementation), via `src/queue/producer.ts`'s `priorityFor`.
- Worker-global concurrency is configurable (`SWARM_WORKER_CONCURRENCY`, default 1), with an enforced per-project `maxConcurrentJobs` cap layered on top.

### Cross-cutting
- One shared structured logger (`src/lib/logger.ts`, SWARM-23) emits JSON log lines (level, ISO timestamp, message, context) for machine parsing, with a `pretty` mode for local dev and a `SWARM_LOG_LEVEL` filter; the router and worker each tag their lines with a `component`.
- Antigravity's actual binary is `agy`, and its `-p`/`--print` flag — unlike Claude's, which is a bare boolean — takes the prompt as its own value: it must be the last flag before the prompt, or it silently swallows whatever comes next as the "prompt" instead (confirmed live: a real Implementation run answered a question about `--dangerously-skip-permissions` instead of doing the task). See the `DEFAULT_ARGS`/`PRINT_FLAG` comment in `src/harness/agent-cli.ts` and `ai/RULES.md` §6.

### Web dashboard (phase-6 backlog)
- Host-run, same model as the worker. API scaffold in place: Hono + tRPC entrypoint (`src/dashboard.ts`, SWARM-75) and its localhost-bound bearer-token auth guard (SWARM-76).
- `projectsRepository` has full CRUD primitives (SWARM-77); a `projects` tRPC router (list/getById/create/update/delete, SWARM-78) is implemented and up for review, not yet merged into `appRouter`.
- `runsRepository` has full CRUD, upsert, and pagination primitives for agent-run history (SWARM-102), ready for future dashboard API/UI integration.
- Runs record per-phase token usage where the agent CLI reports it (issue #138) and curated child observations in `runs.delegations`: parent run and phase, unique child invocation, child model, contract type and paths, duration/usage, outcome, and the primary's accepted/reworked disposition. Child observations are linked to the parent by run id (the SWARM-controlled key the `swarm delegate` command stamps). Delegation contract, event, and review files are scratch, excluded from deterministic delivery. Antigravity has no structured-output flag, so its run usage remains gracefully unavailable.
- A running or deferred run can be terminated from its detail page (issue #166). Terminating a running run stops its agent; terminating a deferred run cancels its scheduled retry. Both settle as a failed run with the user-termination reason, and a terminated deferred run cannot be automatically resumed.
- A `web/` scaffold (Vite + React, TanStack Router/Query, a tRPC client, Tailwind and the `ai/DESIGN_SYSTEM.md` tokens, SWARM-81) is merged; the first real screen (projects list + create dialog, SWARM-82) is implemented.
- The `credentials` tRPC sub-router (list/set/delete, SWARM-79) is implemented under `projectsRouter`, exposing `credentialsRepository` database primitives over the dashboard API; `scm.verifyGithubToken` (SWARM-80) validates a pasted PAT against the GitHub API without storing it.
- The SCM/credentials screen (SWARM-85) is a project-detail tab that manages the three credential references (implementer/reviewer PAT, webhook secret) over `projects.credentials.*`, verifies each PAT via `scm.verifyGithubToken` before saving, and warns — without blocking — when both PATs resolve to the same GitHub login.
- Still backlog: the remaining per-project settings screens (SWARM-86–87).

### Board & roadmap
MVP scope and the active backlog live on the **[GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1)** — org-owned, since a user-owned board (the original location) can't receive the `projects_v2_item` webhook event the Status-changed trigger needs (see `ai/RULES.md` §5 for ids/field details; `KANBAN_BOARD.md` is retired). `PROJECT.md` §8 has the original longer-term roadmap; the MVP path diverges from it as noted throughout this section.

## Contributing

Agent/contributor conventions (including GitHub workflow rules) live in **[`ai/RULES.md`](./ai/RULES.md)** — read it before making changes.
