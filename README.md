# SWARM

**Federated Multi-Agent Automation Framework** — a local-first alternative to centralized, cloud-only coding-agent platforms (e.g. Devin). SWARM automates software engineering workflows end-to-end (plan → implement → respond to review) while keeping source code, compute, and local tooling entirely on the developer's own machine.

> Full architecture, protocol spec, and implementation roadmap: **[`PROJECT.md`](./PROJECT.md)** — the baseline Architecture Design Document (ADD). This README is the short orientation; `PROJECT.md` is the source of truth for exact message shapes, phases, and task breakdown.

> **MVP note**: the "Cloud" half of the architecture below (Cloud Run / Pub/Sub / Firestore) is `PROJECT.md`'s long-term design and is **not** being built yet. The MVP copies [Cascade](https://github.com/mongrel-intelligence/cascade)'s shape instead — a local router + queue in Docker Compose plus a host-run worker, reachable from GitHub via a Cloudflare Tunnel — and targets **GitHub Projects** as its PM tool and **GitHub** as its sole SCM, single-user. See `ai/ARCHITECTURE.md` for the MVP architecture and the [GitHub Projects board](https://github.com/users/jkwiecien/projects/3/views/1) for the current backlog.

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
```

- **Router**: Node.js/TypeScript, Hono — verifies GitHub webhook signatures, resolves the project, enqueues jobs.
- **Queue**: BullMQ on Redis — retries, backoff, concurrency limits.
- **Worker**: drives the worktree + harness lifecycle, invokes `claude` / `antigravity`, streams their stdout/stderr, pushes and opens PRs. Runs on the host (not containerized) so the agent CLIs have the developer's PATH/auth/config.
- **Postgres**: project config, credentials, run history.
- Router, Redis, and Postgres run in one Docker Compose stack; the worker runs alongside on the host — one machine either way, see `PROJECT.md` §2.1 and `ai/ARCHITECTURE.md`.

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

Postgres, Redis, and the router run in Docker Compose; the **worker runs on the host**:

```bash
cp .env.docker.example .env   # adjust POSTGRES_PASSWORD / ports if needed
docker compose up -d --build  # postgres, redis, router (NOT the worker) — detached
npm run db:migrate            # apply the Postgres schema (uses DATABASE_URL from .env)
npm run dev:worker            # start the worker on the host (or: npm run build && npm run start:worker)
```

The `swarm` operator CLI (`src/cli/`, SWARM-22) wraps the config + stack steps above: `swarm init` scaffolds `.env` (from `.env.docker.example`) and a `swarm.config.json` project-config template — validating it if it already exists; `swarm start [--build]` / `swarm stop [-v]` bring the Compose stack up/down; `swarm status` shows the container states and probes the router's `/health`; `swarm logs [service] [-f]` tails the logs. It manages only the containerized stack — the worker still runs on the host (`npm run dev:worker`). Run it from source with `npm run swarm -- <command>`, or `npm run build` and invoke the `swarm` bin directly.

The worker isn't containerized because it provisions Git worktrees and spawns the `claude` / `antigravity` CLIs — those need the developer's own PATH, authentication, and config, which a container wouldn't have. Running it on the host is the local-first fit. It connects to the Compose Redis/Postgres over their published host ports (`REDIS_URL` / `DATABASE_URL` in `.env`), so **`git` and the `claude` / `antigravity` CLIs must be installed and authenticated on your machine** for the worker to get past provision/spawn.

The Postgres schema (project config + credentials at rest) is defined with **Drizzle** in `src/db/` — `npm run db:generate` regenerates migrations from the schema, `npm run db:migrate` applies them. Credentials are encrypted with AES-256-GCM before storage when `CREDENTIAL_MASTER_KEY` is set (plaintext otherwise, for local dev).

SWARM's host ports are offset from Cascade's defaults (router `3100` vs `3000`, Postgres `5433` vs `5432`, Redis `6380` vs `6379`) so both stacks can run in parallel without a host-port clash — the compose project name is fixed to `swarm`, giving it its own network and volumes. Override any of them via `ROUTER_PORT` / `POSTGRES_PORT` / `REDIS_PORT` in `.env`.

The router exposes a health check at `http://localhost:${ROUTER_PORT:-3100}/health`. The router now serves the GitHub webhook receiver (`POST /github/webhook`) — HMAC signature verification, project resolution, and the loop-prevention drop gate (SWARM-9) — for both the repo-scoped SCM events and the GitHub Projects `projects_v2_item` board event (SWARM-12), the latter resolving the project by board node ID and filtering to Status-field changes before the enqueue seam. At that seam it shapes the parsed event into the router→worker job contract (`SwarmJobSchema` on the `swarm-jobs` queue, `src/queue/jobs.ts`) and enqueues it onto BullMQ via the producer (`src/queue/producer.ts`, SWARM-35), using GitHub's delivery id as the job id so redelivered webhooks dedupe. The worker side is wired end to end (SWARM-17): a long-lived BullMQ consumer (`src/worker/index.ts`) validates each dequeued job, resolves it through a trigger registry (`src/triggers/`, SWARM-53), and dispatches each matched trigger to the pipeline phase it names. Each phase drives the full lifecycle — `GitWorktreeManager` (`src/worker/git-worktree-manager.ts`, SWARM-14) provisions an isolated per-task worktree under `.swarm-workspaces/task-<id>/` (with a detached-HEAD mode for read-only phases), `graftEnvironment` (`src/worktree/graft.ts`, SWARM-15) symlinks untracked build state (`node_modules`, `.env`, caches) into it, the agent-CLI runtime (`src/harness/agent-cli.ts`, SWARM-16) spawns `claude`/`antigravity` with the worktree as CWD, and the worktree is force-cleaned afterwards. All four pipeline phases compose those same building blocks (`src/pipeline/`): the **Planning phase** (SWARM-18) provisions a detached worktree, runs Antigravity to write `proposed_plan.md`, posts it as a comment on the linked Issue, and moves the item to "ToDo"; the **Implementation phase** (SWARM-19) provisions a task-branch worktree, runs Claude Code (implementer persona) to implement the plan and open a PR via `gh`, links the PR back on the item, and moves it to "In review"; the **Review phase** (SWARM-20) provisions a detached worktree at the PR's head SHA and runs Claude Code as the *reviewer* persona (its token handed to the CLI as `GH_TOKEN`) to read the diff and submit a formal `gh pr review` — approve / request changes / comment; the **Respond-to-review phase** (SWARM-21) provisions a worktree on the PR's existing task branch and runs Claude Code as the implementer to address the reviewer's batched review point by point — fixing the code and pushing, or pushing back with a rationale in a PR reply. The trigger registry now wires all four (SWARM-53): a single **status-change handler** (`src/triggers/handlers/pm-status.ts`) re-reads the board item authoritatively and starts Planning or Implementation by the card's Status, while **PR-lifecycle handlers** start Review (on a non-draft, same-repo PR opening or its check suite passing) and Respond-to-review (on the reviewer persona submitting a changes-requested review). The concrete GitHub Projects `PMProvider` (`src/integrations/pm/github-projects/provider.ts` — GraphQL item read/move plus linked-Issue comments) backs the two board-driven phases. Cross-process review dedup and check-suite recheck/respond-to-ci are deliberately deferred (see the handler headers).

To let GitHub reach this local router with webhooks, expose it over a public HTTPS URL with a Cloudflare Tunnel — see **[`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md)** for the setup (quick tunnel for dev, named tunnel for a stable URL) and the GitHub webhook configuration.

## Status

Early implementation — the Node.js/TypeScript toolchain is scaffolded (strict TS + ESM, `@/*` alias, Biome, Vitest, Lefthook, commitlint; `npm run verify` runs lint + typecheck + tests), and the Postgres persistence layer (Drizzle schema + migrations for project config and encrypted-at-rest credentials) is in place. The GitHub SCM layer has started: dual-persona (`implementer`/`reviewer`) credential scoping via `AsyncLocalStorage`, per-persona token resolution from Postgres, and the router adapter that parses inbound webhooks, resolves the project, and enforces loop prevention. The router now also serves the HTTP webhook receiver — HMAC-SHA256 signature verification on `POST /github/webhook`, feeding that adapter through to an enqueue seam that now shapes each verified event into a `SwarmJob` and pushes it onto the `swarm-jobs` BullMQ queue via the producer (SWARM-35). On the PM side, the GitHub Projects `projects_v2_item` board webhook is now routed too (SWARM's `pm:status-changed` ingress): a PM router adapter resolves the SWARM project by board node ID, filters to Status-field edits, and the provider-agnostic Status-option → pipeline-phase mapping is in place. The PM provider now self-registers through a manifest + registry loaded from a single canonical entrypoint (`src/integrations/entrypoint.ts`), so the receiver resolves its adapter by id rather than hardcoding it (SWARM-13). On the worker side, the BullMQ job consumer (SWARM-17) resolves each dequeued job through a Cascade-style trigger registry and dispatches the matched trigger to its pipeline phase, which ties the Phase-3 building blocks together: per-task worktree lifecycle (`GitWorktreeManager`, SWARM-14), environment grafting (SWARM-15), and the agent-CLI execution engine (SWARM-16). All four pipeline phases compose those same blocks and are now wired into the trigger registry (SWARM-53): Planning (SWARM-18 — detached worktree → Antigravity writes `proposed_plan.md` → plan posted on the linked Issue → item moved to "ToDo"), Implementation (SWARM-19 — task-branch worktree → Claude Code implements, pushes, opens the PR via `gh` → PR linked on the item → item moved to "In review"), Review (SWARM-20 — detached worktree at the PR's head SHA → Claude Code as the reviewer persona, authenticated via `GH_TOKEN`, reads the diff and submits a formal `gh pr review`), and Respond-to-review (SWARM-21 — worktree on the PR's existing task branch → Claude Code as the implementer addresses the batched review, pushing fixes or pushing back with a rationale). The BullMQ producer at the router's enqueue seam (SWARM-35) now shapes each verified webhook event into a `SwarmJob` and pushes it onto the `swarm-jobs` queue (delivery id as job id for idempotency), so the router→worker path is connected end to end. Across all of this, one shared structured logger (`src/lib/logger.ts`, SWARM-23) emits JSON log lines (level, ISO timestamp, message, context) for machine parsing — with a `pretty` mode for local dev and a `SWARM_LOG_LEVEL` filter — and the router and worker each tag their lines with a `component` so a shared stream stays attributable. The concrete GitHub Projects `PMProvider` GraphQL adapter (authoritative item read/move plus linked-Issue comments) now backs the board-driven phases, and the trigger handlers (`src/triggers/handlers/`) dispatch each event to its phase (SWARM-53); the worker's consumer resolves the phase and hands off to the orchestrator, mapping its result to the job outcome. Deferred as follow-ups: cross-process review dedup, check-suite incomplete-check recheck, and a respond-to-ci phase. MVP scope and the active backlog live on the **[GitHub Projects board](https://github.com/users/jkwiecien/projects/3/views/1)** (see `ai/RULES.md` §5 for ids/field details; `KANBAN_BOARD.md` is retired). `PROJECT.md` §8 has the original longer-term roadmap; the MVP path diverges from it as noted above.

## Contributing

Agent/contributor conventions (including GitHub workflow rules) live in **[`ai/RULES.md`](./ai/RULES.md)** — read it before making changes.
