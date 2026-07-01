# Kanban Board

Stand-in project board until SWARM's own GitHub Projects integration (see `PROJECT.md`) is wired up and can host this itself. Columns mirror what a GitHub Projects board looks like, so the migration later is a straight lift.

Each task: `- [ ] <id> — <title>` with an optional indented note. Move a task by cutting/pasting its line into the target column — don't leave stale copies behind.

---

## MVP scope (agreed 2026-07-01)

- **Architecture**: copy Cascade's shape — local router + BullMQ/Redis queue + worker, Postgres for config/credentials/run history, all in Docker Compose. No GCP (Cloud Run / Pub/Sub / Firestore) yet — that's `PROJECT.md`'s longer-term design, deferred. GitHub webhooks reach the local router via a Cloudflare Tunnel (external setup, not SWARM's concern).
- **PM provider**: GitHub Projects (v2) — net-new, no Cascade equivalent to copy directly.
- **SCM**: GitHub — copy Cascade's implementation closely (dual-persona implementer/reviewer tokens, loop prevention).
- **Pipeline phases**: all four from `PROJECT.md` §5 — Planning (Antigravity) → Implementation (Claude Code) → Review (Claude Code, reviewer persona) → Respond-to-review (Claude Code, implementer persona).
- **Tenancy**: single-user. No org/device-mapping layer.

Full detail: `ai/ARCHITECTURE.md`, `ai/CODING_STANDARDS.md`, `ai/TESTING.md`.

---

## Backlog

### Phase 0 — Foundation
- [ ] SWARM-2 — Docker Compose stack: Redis, Postgres, router service, worker service
- [ ] SWARM-3 — Document Cloudflare Tunnel setup for exposing the local router to GitHub webhooks (ops doc, not code — tunnel itself is external)
- [ ] SWARM-4 — Project config Zod schema: repo, worktree root, GitHub Projects board mapping, credential references
- [ ] SWARM-5 — Postgres schema + migrations for project config and credentials at rest (mirror Cascade's `project_credentials` pattern)

### Phase 1 — GitHub SCM integration
- [ ] SWARM-6 — Set up dual-persona GitHub identities (implementer + reviewer bot accounts/tokens)
- [ ] SWARM-7 — `src/integrations/scm/github/`: credential scoping (`withGitHubToken` via AsyncLocalStorage), `isSwarmBot` loop-prevention check
- [ ] SWARM-8 — GitHub webhook receiver: signature verification + router adapter for `pull_request`, `pull_request_review`, `issue_comment`, `check_suite`

### Phase 2 — GitHub Projects PM provider (net-new)
- [ ] SWARM-9 — Spike: GitHub Projects v2 GraphQL API — item/field shape, `projects_v2_item` webhook event, auth scopes needed
- [ ] SWARM-10 — Define `PMProvider`-shaped interface for GitHub Projects (mirror Cascade's `src/pm/types.ts`): getWorkItem, moveWorkItem (status field), addComment (on linked issue), listWorkItems
- [ ] SWARM-11 — GitHub Projects webhook adapter + status-changed trigger (Projects status field → pipeline phase)
- [ ] SWARM-12 — Provider manifest + registry entry (single-entrypoint registration, mirror Cascade's pattern)

### Phase 3 — Worktree + agent execution engine
- [ ] SWARM-13 — `GitWorktreeManager`: provision/cleanup worktrees per task (`PROJECT.md` §4)
- [ ] SWARM-14 — Environment grafting: symlink `node_modules`, `.env`, build caches into worktrees
- [ ] SWARM-15 — Harness orchestrator: spawn `claude` / `antigravity` CLIs with worktree as CWD, stream stdout/stderr, capture exit codes
- [ ] SWARM-16 — Worker: BullMQ job consumer wiring trigger → worktree → harness → cleanup

### Phase 4 — Pipeline phases
- [ ] SWARM-17 — Planning phase: item → Planning status → worktree → Antigravity writes `proposed_plan.md` → posted as comment on linked issue → status moved forward
- [ ] SWARM-18 — Implementation phase: item → In Progress → worktree → Claude Code (implementer) implements plan, runs tests, commits, pushes → PR opened + linked back to Projects item
- [ ] SWARM-19 — Review phase: PR opened / check suite success → Claude Code (reviewer) reviews diff, posts PR review comments
- [ ] SWARM-20 — Respond-to-review phase: review submitted with `changes_requested` → Claude Code (implementer) addresses batched comments, pushes fix or pushes back with rationale

### Phase 5 — Ops / DX
- [ ] SWARM-21 — `swarm-cli` commands: init project config, start/stop local stack, status, logs
- [ ] SWARM-22 — Structured logging across router/worker
- [ ] SWARM-23 — End-to-end smoke test: one full Planning→Implementation→Review→Respond-to-review run against a scratch repo/project
- [ ] SWARM-24 — Type-check test files: `tsconfig`'s `include: ["src"]` leaves `tests/**` unchecked by `tsc --noEmit`, so type errors in tests ship silently (same gap as Cascade). Close via a `tsconfig` that also covers `tests/` or `vitest --typecheck`. (PR #1 review nit)

## To do

## In progress

## In review

- [ ] SWARM-1 — Scaffold Node.js/TypeScript project: package.json, strict tsconfig + `@/*` alias, Biome, Vitest, Lefthook, commitlint (mirror Cascade's configs)

## Done
