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
```

The router exposes a health check at `http://localhost:${ROUTER_PORT:-3000}/health`. Router and worker are placeholder services for now — the webhook/enqueue logic (SWARM-9), BullMQ consumer (SWARM-17), and agent-CLI runtime (SWARM-16) land in later tasks; this stack is the Phase 0 foundation they build on.

## Status

Early implementation — the Node.js/TypeScript toolchain is scaffolded (strict TS + ESM, `@/*` alias, Biome, Vitest, Lefthook, commitlint; `npm run verify` runs lint + typecheck + tests). Application code (router/worker/providers) is not built yet. MVP scope and the active backlog live on the **[GitHub Projects board](https://github.com/users/jkwiecien/projects/3/views/1)** (see `ai/RULES.md` §5 for ids/field details; `KANBAN_BOARD.md` is retired). `PROJECT.md` §8 has the original longer-term roadmap; the MVP path diverges from it as noted above.

## Contributing

Agent/contributor conventions (including GitHub workflow rules) live in **[`ai/RULES.md`](./ai/RULES.md)** — read it before making changes.
