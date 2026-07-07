# SWARM

**Federated Multi-Agent Automation Framework** — a local-first alternative to centralized, cloud-only coding-agent platforms (e.g. Devin). SWARM automates software engineering workflows end-to-end (plan → implement → respond to review) while keeping source code, compute, and local tooling entirely on the developer's own machine.

> Full architecture, protocol spec, and implementation roadmap: **[`PROJECT.md`](./PROJECT.md)** — the baseline Architecture Design Document (ADD). This README is the short orientation; `PROJECT.md` is the source of truth for exact message shapes, phases, and task breakdown.

> **MVP note**: the "Cloud" half of the architecture below (Cloud Run / Pub/Sub / Firestore) is `PROJECT.md`'s long-term design and is **not** being built yet. The MVP copies [Cascade](https://github.com/mongrel-intelligence/cascade)'s shape instead — a local router + queue in Docker Compose plus a host-run worker, reachable from GitHub via a Cloudflare Tunnel — and targets **GitHub Projects** as its PM tool and **GitHub** as its sole SCM, single-user. See `ai/ARCHITECTURE.md` for the MVP architecture and the [GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1) for the current backlog.

**Contents**: [Core idea](#core-idea) · [Architecture at a glance](#architecture-at-a-glance-mvp) · [Pipeline phases](#pipeline-phases) · [Security model](#security-model) · [Extensibility](#extensibility) · [Running the stack](#running-the-stack-local) · [Status](#status) · [Contributing](#contributing)

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
- **Worker**: drives the worktree + harness lifecycle, invokes `claude` / `antigravity`, streams their stdout/stderr, pushes and opens PRs. Runs on the host (not containerized) so the agent CLIs have the developer's PATH/auth/config.
- **Dashboard**: self-hosted config/credentials API, also host-run — see "Running the stack" below.
- **Postgres**: project config, credentials, run history.
- Router, Redis, and Postgres run in one Docker Compose stack; the worker and dashboard run alongside on the host — one machine either way, see `PROJECT.md` §2.1 and `ai/ARCHITECTURE.md`.

The original cloud-engine design (Cloud Run + Pub/Sub + Firestore + a gRPC-connected daemon) is deferred — see `PROJECT.md` §2.2/§3 for that design once it's revisited.

## Pipeline phases

Each phase's agent CLI and model are configurable per project, per phase, via `swarm.config.json`'s `agents` block (`src/harness/models.ts` is the catalog of valid `cli`/`model` combinations) — the descriptions below are the code's own defaults when a project doesn't override them. Planning and Implementation are the only two phases that move the board's Status themselves, and each does so conditionally on an `autoAdvance` setting (also per-phase, in `swarm.config.json`'s `pipeline` block): Planning defaults to **off** (a human reviews the plan and moves it to "ToDo" themselves), Implementation defaults to **on** (moves straight to "In review" once the PR is up).

1. **Planning** (Claude Code by default) — item moves to "Planning" → the worker provisions a detached worktree, the planning agent reads the code graph and writes `proposed_plan.md` → plan is posted back to the board. Moves the item to "ToDo" itself if `autoAdvance` is on for this project; otherwise a human moves it once they've reviewed the plan.
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

The dashboard API requires `DASHBOARD_TOKEN` to be set in your `.env` file and throws on startup if it is missing. Because it binds to `127.0.0.1` and uses Hono's `bearerAuth` middleware, every dashboard API request (except `/health`) must include the token in the `Authorization` header. When present, the dashboard API also serves the built `web/dist` SPA statically as a fallback (self-hosted mode) for any non-API/non-health routes. Future frontends read the token from local configuration rather than displaying a login screen.

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

It manages only the containerized stack — the worker still runs on the host (`npm run dev:worker`). Run it from source with `npm run swarm -- <command>`, or `npm run build` and invoke the `swarm` bin directly.

The worker isn't containerized because it provisions Git worktrees and spawns the `claude` / `antigravity` CLIs — those need the developer's own PATH, authentication, and config, which a container wouldn't have. Running it on the host is the local-first fit. It connects to the Compose Redis/Postgres over their published host ports (`REDIS_URL` / `DATABASE_URL` in `.env`), so **`git` and the `claude` / `antigravity` CLIs must be installed and authenticated on your machine** for the worker to get past provision/spawn.

The Postgres schema (project config + credentials at rest) is defined with **Drizzle** in `src/db/` — `npm run db:generate` regenerates migrations from the schema, `npm run db:migrate` applies them. Credentials are encrypted with AES-256-GCM before storage when `CREDENTIAL_MASTER_KEY` is set (plaintext otherwise, for local dev).

SWARM's host ports are offset from Cascade's defaults (router `3100` vs `3000`, dashboard `3101` vs `3001`, Postgres `5433` vs `5432`, Redis `6380` vs `6379`) so both stacks can run in parallel without a host-port clash — the compose project name is fixed to `swarm`, giving it its own network and volumes. Override any of them via `ROUTER_PORT` / `DASHBOARD_PORT` / `POSTGRES_PORT` / `REDIS_PORT` in `.env`.

The router exposes a health check at `http://localhost:${ROUTER_PORT:-3100}/health`; the dashboard exposes one at `http://localhost:${DASHBOARD_PORT:-3101}/health` plus a tRPC endpoint at `/trpc`. The router's webhook receiver (`POST /github/webhook`) verifies HMAC signatures, resolves the project, and applies a loop-prevention drop gate (SWARM-9) for both repo-scoped SCM events and the GitHub Projects board event, then hands off to the job queue. From there, a trigger registry dispatches each event to the pipeline phase it names — see [Pipeline phases](#pipeline-phases) above for what each phase does, and [Status](#status) below for the implementation detail behind the queue, trigger registry, and dedup/retry logic.

To let GitHub reach this local router with webhooks, expose it over a public HTTPS URL with a Cloudflare Tunnel — see **[`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md)** for the setup (a quick ephemeral tunnel for dev, a CLI-managed named tunnel for a stable URL, or a dashboard-created tunnel run as an opt-in `cloudflared` service in `docker-compose.yml` so it starts with the rest of the stack) and the GitHub webhook configuration.

## Status

Early implementation. Summary by area:

### Toolchain & persistence
- Node.js/TypeScript toolchain scaffolded: strict TS + ESM, `@/*` alias, Biome, Vitest, Lefthook, commitlint; `npm run verify` runs lint + typecheck + tests.
- Postgres persistence layer in place: Drizzle schema + migrations for project config and encrypted-at-rest credentials.

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
- Shared building blocks (`src/pipeline/`): per-task worktree lifecycle (`GitWorktreeManager`, `src/worker/git-worktree-manager.ts`, SWARM-14 — provisions an isolated worktree under `.swarm-workspaces/task-<id>/`, with a detached-HEAD mode for read-only phases), environment grafting (`graftEnvironment`, `src/worktree/graft.ts`, SWARM-15 — symlinks `node_modules`/`.env`/caches into it), and the agent-CLI execution engine (`src/harness/agent-cli.ts`, SWARM-16 — spawns `claude`/`antigravity` with the worktree as CWD).
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
- Job-priority split: PR review-lifecycle jobs (`pull_request`/`pull_request_review`/`check_suite`) always dequeue ahead of PM-board jobs (`projects_v2_item`, which drive Planning/Implementation), via `src/queue/producer.ts`'s `priorityFor`.
- Worker concurrency is configurable (`SWARM_WORKER_CONCURRENCY`, default 1) instead of hardcoded to one job at a time.

### Cross-cutting
- One shared structured logger (`src/lib/logger.ts`, SWARM-23) emits JSON log lines (level, ISO timestamp, message, context) for machine parsing, with a `pretty` mode for local dev and a `SWARM_LOG_LEVEL` filter; the router and worker each tag their lines with a `component`.
- Antigravity's actual binary is `agy`, and its `-p`/`--print` flag — unlike Claude's, which is a bare boolean — takes the prompt as its own value: it must be the last flag before the prompt, or it silently swallows whatever comes next as the "prompt" instead (confirmed live: a real Implementation run answered a question about `--dangerously-skip-permissions` instead of doing the task). See the `DEFAULT_ARGS`/`PRINT_FLAG` comment in `src/harness/agent-cli.ts` and `ai/RULES.md` §6.

### Web dashboard (phase-6 backlog)
- Host-run, same model as the worker. API scaffold in place: Hono + tRPC entrypoint (`src/dashboard.ts`, SWARM-75) and its localhost-bound bearer-token auth guard (SWARM-76).
- `projectsRepository` has full CRUD primitives (SWARM-77); a `projects` tRPC router (list/getById/create/update/delete, SWARM-78) is implemented and up for review, not yet merged into `appRouter`.
- A `web/` scaffold (Vite + React, TanStack Router/Query, a tRPC client, Tailwind and the `ai/DESIGN_SYSTEM.md` tokens, SWARM-81) is merged; the first real screen (projects list + create dialog, SWARM-82) is implemented.
- Still backlog: credentials management (SWARM-79/80), and the remaining per-project settings screens (SWARM-83–87).

### Board & roadmap
MVP scope and the active backlog live on the **[GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1)** — org-owned, since a user-owned board (the original location) can't receive the `projects_v2_item` webhook event the Status-changed trigger needs (see `ai/RULES.md` §5 for ids/field details; `KANBAN_BOARD.md` is retired). `PROJECT.md` §8 has the original longer-term roadmap; the MVP path diverges from it as noted throughout this section.

## Contributing

Agent/contributor conventions (including GitHub workflow rules) live in **[`ai/RULES.md`](./ai/RULES.md)** — read it before making changes.
