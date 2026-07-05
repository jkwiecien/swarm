# SWARM

**Federated Multi-Agent Automation Framework** — a local-first alternative to centralized, cloud-only coding-agent platforms (e.g. Devin). SWARM automates software engineering workflows end-to-end (plan → implement → respond to review) while keeping source code, compute, and local tooling entirely on the developer's own machine.

> Full architecture, protocol spec, and implementation roadmap: **[`PROJECT.md`](./PROJECT.md)** — the baseline Architecture Design Document (ADD). This README is the short orientation; `PROJECT.md` is the source of truth for exact message shapes, phases, and task breakdown.

> **MVP note**: the "Cloud" half of the architecture below (Cloud Run / Pub/Sub / Firestore) is `PROJECT.md`'s long-term design and is **not** being built yet. The MVP copies [Cascade](https://github.com/mongrel-intelligence/cascade)'s shape instead — a local router + queue + worker (Docker Compose), reachable from GitHub via a Cloudflare Tunnel — and targets **GitHub Projects** as its PM tool and **GitHub** as its sole SCM, single-user. See `ai/ARCHITECTURE.md` for the MVP architecture and the [GitHub Projects board](https://github.com/users/jkwiecien/projects/3/views/1) for the current backlog.

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
Worker  (Docker container)
   — resolves trigger handler → git worktree add (isolated sandbox) → claude / antigravity-cli (CWD = worktree)
   — commit + push → PR opened/updated → GitHub Projects item updated
```

- **Router**: Node.js/TypeScript, Hono — verifies GitHub webhook signatures, resolves the project, enqueues jobs.
- **Queue**: BullMQ on Redis — retries, backoff, concurrency limits.
- **Worker**: drives the worktree + harness lifecycle, invokes `claude` / `antigravity`, streams their stdout/stderr, pushes and opens PRs.
- **Postgres**: project config, credentials, run history.
- All of the above run in one Docker Compose stack, on one machine — see `PROJECT.md` §2.1 and `ai/ARCHITECTURE.md`.

The original cloud-engine design (Cloud Run + Pub/Sub + Firestore + a gRPC-connected daemon) is deferred — see `PROJECT.md` §2.2/§3 for that design once it's revisited.

## Pipeline phases

1. **Planning** (Antigravity) — item moves to "Planning" → the worker provisions a worktree, Antigravity reads the code graph and writes `proposed_plan.md` → plan is posted back to the board.
2. **Implementation** (Claude Code, implementer persona) — item moves to "In Progress" → the worker opens a worktree on the task branch, Claude Code implements the plan, runs tests, commits, pushes → PR opened and linked back to the board.
3. **Review** (Claude Code, reviewer persona) — PR opened / checks pass → the reviewer persona reviews the diff and posts PR review comments.
4. **Respond to Review** (Claude Code, implementer persona) — the reviewer submits a review with changes requested → the worker opens a worktree on the PR branch, the implementer persona processes the full batch of review comments (fix, or push back with a rationale) → replies posted to the review thread.

## Security model

- **Dual-persona GitHub credentials** (MVP): separate implementer/reviewer tokens, borrowed from Cascade's loop-prevention model — a persona never reacts to its own output. Stored in Postgres, not a cloud secret manager (see `PROJECT.md` §6.1).
- **Zero-knowledge codebase, still**: everything above is local — router, worker, Postgres, Redis. Nothing leaves the machine except webhook payloads and PR/comment metadata.
- *(Future, once `PROJECT.md` §2.2's cloud engine exists)*: board/SCM API keys move into Google Cloud Secret Manager; the daemon authenticates to the cloud via a bearer token + device hardware ID (`PROJECT.md` §6.2).

## Extensibility

PM boards plug in via an agnostic `PMProvider` interface (verify webhook, get/list/move work items, comment) — see `PROJECT.md` §7. This mirrors the manifest/registry-based provider-abstraction pattern used by the reference project, **[Cascade](https://github.com/mongrel-intelligence/cascade)** (sibling directory, symlinked here as `cascade`), which the MVP copies directly rather than merely drawing inspiration from. GitHub Projects is the only concrete provider for the MVP; the interface exists so a second one (Trello, JIRA, Linear, Asana, …) could be added later without touching router/worker dispatch code.

## Running the stack (local)

All four services run in one Docker Compose stack:

```bash
cp .env.docker.example .env   # adjust POSTGRES_PASSWORD / ports if needed
docker compose up --build     # postgres, redis, router, worker
npm run db:migrate            # apply the Postgres schema (uses DATABASE_URL from .env)
```

The Postgres schema (project config + credentials at rest) is defined with **Drizzle** in `src/db/` — `npm run db:generate` regenerates migrations from the schema, `npm run db:migrate` applies them. Credentials are encrypted with AES-256-GCM before storage when `CREDENTIAL_MASTER_KEY` is set (plaintext otherwise, for local dev).

SWARM's host ports are offset from Cascade's defaults (router `3100` vs `3000`, Postgres `5433` vs `5432`, Redis `6380` vs `6379`) so both stacks can run in parallel without a host-port clash — the compose project name is fixed to `swarm`, giving it its own network and volumes. Override any of them via `ROUTER_PORT` / `POSTGRES_PORT` / `REDIS_PORT` in `.env`.

The router exposes a health check at `http://localhost:${ROUTER_PORT:-3100}/health`. The router now serves the GitHub webhook receiver (`POST /github/webhook`) — HMAC signature verification, project resolution, and the loop-prevention drop gate (SWARM-9) — for both the repo-scoped SCM events and the GitHub Projects `projects_v2_item` board event (SWARM-12), the latter resolving the project by board node ID and filtering to Status-field changes before the enqueue seam. It stops at that seam: the router→worker job contract now exists (`SwarmJobSchema` on the `swarm-jobs` queue, `src/queue/jobs.ts`), but the BullMQ producer that pushes onto it is still open (SWARM-35). The worker side is wired end to end (SWARM-17): a long-lived BullMQ consumer (`src/worker/index.ts`) validates each dequeued job, resolves it through a trigger registry (`src/triggers/`), and for a matched trigger drives the full lifecycle — `GitWorktreeManager` (`src/worker/git-worktree-manager.ts`, SWARM-14) provisions an isolated per-task worktree under `.swarm-workspaces/task-<id>/` (with a detached-HEAD mode for read-only phases), `graftEnvironment` (`src/worktree/graft.ts`, SWARM-15) symlinks untracked build state (`node_modules`, `.env`, caches) into it, the agent-CLI runtime (`src/harness/agent-cli.ts`, SWARM-16) spawns `claude`/`antigravity` with the worktree as CWD, and the worktree is force-cleaned afterwards. Three of the four pipeline phases compose those same building blocks (`src/pipeline/`): the **Planning phase** (SWARM-18) provisions a detached worktree, runs Antigravity to write `proposed_plan.md`, posts it as a comment on the linked Issue, and moves the item to "ToDo"; the **Implementation phase** (SWARM-19) provisions a task-branch worktree, runs Claude Code (implementer persona) to implement the plan and open a PR via `gh`, links the PR back on the item, and moves it to "In review"; the **Review phase** (SWARM-20) provisions a detached worktree at the PR's head SHA and runs Claude Code as the *reviewer* persona (its token handed to the CLI as `GH_TOKEN`) to read the diff and submit a formal `gh pr review` — approve / request changes / comment. None are registered as trigger handlers yet, so every dequeued job currently completes as a logged no-op; Respond-to-review (SWARM-21) and wiring the phases into the registry are what remain.

To let GitHub reach this local router with webhooks, expose it over a public HTTPS URL with a Cloudflare Tunnel — see **[`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md)** for the setup (quick tunnel for dev, named tunnel for a stable URL) and the GitHub webhook configuration.

## Status

Early implementation — the Node.js/TypeScript toolchain is scaffolded (strict TS + ESM, `@/*` alias, Biome, Vitest, Lefthook, commitlint; `npm run verify` runs lint + typecheck + tests), and the Postgres persistence layer (Drizzle schema + migrations for project config and encrypted-at-rest credentials) is in place. The GitHub SCM layer has started: dual-persona (`implementer`/`reviewer`) credential scoping via `AsyncLocalStorage`, per-persona token resolution from Postgres, and the router adapter that parses inbound webhooks, resolves the project, and enforces loop prevention. The router now also serves the HTTP webhook receiver — HMAC-SHA256 signature verification on `POST /github/webhook`, feeding that adapter through to an enqueue seam. On the PM side, the GitHub Projects `projects_v2_item` board webhook is now routed too (SWARM's `pm:status-changed` ingress): a PM router adapter resolves the SWARM project by board node ID, filters to Status-field edits, and the provider-agnostic Status-option → pipeline-phase mapping is in place. The PM provider now self-registers through a manifest + registry loaded from a single canonical entrypoint (`src/integrations/entrypoint.ts`), so the receiver resolves its adapter by id rather than hardcoding it (SWARM-13). On the worker side, the BullMQ job consumer (SWARM-17) now ties the Phase-3 building blocks together: per-task worktree lifecycle (`GitWorktreeManager`, SWARM-14), environment grafting (SWARM-15), and the agent-CLI execution engine (SWARM-16), all driven per dequeued job through a Cascade-style trigger registry. Three pipeline phases compose those same blocks, none registered in the trigger registry yet: Planning (SWARM-18 — detached worktree → Antigravity writes `proposed_plan.md` → plan posted on the linked Issue → item moved to "ToDo"), Implementation (SWARM-19 — task-branch worktree → Claude Code implements, pushes, opens the PR via `gh` → PR linked on the item → item moved to "In review"), and Review (SWARM-20 — detached worktree at the PR's head SHA → Claude Code as the reviewer persona, authenticated via `GH_TOKEN`, reads the diff and submits a formal `gh pr review`). The queue producer at the router's enqueue seam (SWARM-35), the concrete GitHub Projects `PMProvider` GraphQL adapter (the authoritative item re-read/write), the Respond-to-review phase (SWARM-21), and the trigger handlers that wire the pipeline phases into the registry are not built yet. MVP scope and the active backlog live on the **[GitHub Projects board](https://github.com/users/jkwiecien/projects/3/views/1)** (see `ai/RULES.md` §5 for ids/field details; `KANBAN_BOARD.md` is retired). `PROJECT.md` §8 has the original longer-term roadmap; the MVP path diverges from it as noted above.

## Contributing

Agent/contributor conventions (including GitHub workflow rules) live in **[`ai/RULES.md`](./ai/RULES.md)** — read it before making changes.
