# Architecture (MVP)

`PROJECT.md` describes SWARM's long-term vision: a stateless GCP cloud orchestrator (Cloud Run + Pub/Sub + Firestore) talking gRPC to a local daemon. **For the MVP, skip the GCP layer entirely** and mirror Cascade's architecture instead — a router + queue + worker running locally (Docker Compose, same as Cascade), reachable from GitHub via a Cloudflare Tunnel instead of a cloud ingress service. The gRPC/cloud-engine design in `PROJECT.md` is not being built yet; treat it as a possible future phase once the local-only version works end-to-end for one user, not as the current target. If this changes, update this file and `README.md` in the same change.

## Why copy Cascade's shape instead of `PROJECT.md`'s

`PROJECT.md` was written before we had a concrete reference implementation to copy. Cascade already solves "webhook comes in → figure out which project/task it belongs to → run an agent → report back" for exactly this kind of pipeline, in the same language, and its author knew Node.js well. Rebuilding that shape from scratch (or building the gRPC/Pub/Sub version) is strictly more work for no MVP-stage benefit. SWARM's two product differences from Cascade are:

1. **PM provider = GitHub Projects**, not Trello/JIRA/Linear (Cascade explicitly has no GitHub Projects adapter — this is net-new).
2. **SCM = GitHub**, same as Cascade — copy this piece close to verbatim.

Everything else — router/queue/worker split, manifest-based provider registration, credential scoping, loop prevention — should be copied, not reinvented.

## Components (MVP)

```
GitHub (repo + Projects v2)
   │  webhooks (pull_request, pull_request_review, issue_comment, check_suite, projects_v2_item)
   ▼
Cloudflare Tunnel (external, not our concern — just a public HTTPS URL pointed at the router)
   ▼
Router  (Hono HTTP server, local Docker container)
   — verifies webhook signatures
   — resolves which SWARM project the event belongs to
   — enqueues a job (BullMQ / Redis)
   ▼
Worker  (local Docker container, one job at a time or a small pool)
   — looks up the trigger handler for the event
   — provisions a Git worktree (see "Worktree lifecycle" below)
   — spawns `claude` or `antigravity` CLI with the worktree as CWD
   — commits/pushes, opens/updates a PR, posts back to GitHub Projects
```

Redis (for BullMQ) and Postgres (for project config, credentials at rest, and run history — same role it plays in Cascade) run alongside the router/worker in the same Docker Compose stack. There is no separate "cloud" process for the MVP; router, worker, Redis, and Postgres are all local.

## Provider abstraction

Two integrations, each following the manifest/registry pattern from `ai/CODING_STANDARDS.md`:

### SCM: GitHub (`src/integrations/scm/github/`)

The integration itself lives under `src/integrations/scm/github/` — consistent with the PM provider (`src/integrations/pm/github-projects/`) and the module shape in `ai/CODING_STANDARDS.md` — but its internals are ported close to verbatim from Cascade's `src/github/*`, so match Cascade's file shapes (`scm-integration.ts`, `client.ts`, `personas.ts`) rather than reinventing them. The router adapter is router infrastructure, so it lives under `src/router/adapters/github.ts` (mirroring Cascade), not inside the integration folder.

- Dual-persona tokens (`implementer`, `reviewer`) scoped via `AsyncLocalStorage` (`src/integrations/scm/github/client.ts`'s `withGitHubToken`), never passed as plain arguments. Token references live in the project config's `credentials` block; the secrets themselves are resolved from Postgres per-persona (`src/config/provider.ts` → `src/db/repositories/credentialsRepository.ts`).
- Router adapter (`src/router/adapters/github.ts`) parses `pull_request`, `pull_request_review`, `issue_comment`, `check_suite` events, resolves the SWARM project from the repo, and dispatches with the right persona's credentials in scope.
- Loop prevention via an `isSwarmBot(login)` check (`src/integrations/scm/github/personas.ts`) on comment events, exactly as described in `ai/CODING_STANDARDS.md` — a persona never reacts to its own ack/reply comments; PR/review lifecycle routing between personas is handled by `getPersonaForLogin`, not by the drop gate.

### PM: GitHub Projects (`src/integrations/pm/github-projects/`) — net-new, no Cascade equivalent

GitHub Projects (v2) is GraphQL-only; there is no REST equivalent for reading/writing item fields. Shape the provider around:

- **Work item** = a Projects v2 item (usually backed by an Issue or PR in the repo).
- **Status** = the item's single-select "Status" custom field — moving a task through the pipeline (Backlog → Planning → In Progress → In Review → Done) means updating that field's option value via `updateProjectV2ItemFieldValue`.
- **Events** = the `projects_v2_item` webhook event (`created`, `edited`, `reordered`, `deleted`), filtered to status-field edits — this is the equivalent of Cascade's `pm:status-changed` trigger. It is **never** a repo-level event: GitHub delivers it on an **organization** webhook or to a **GitHub App** with the Projects permission (there is no plain user-account webhook). For SWARM's user-owned board the App route is effectively the only option — see `docs/github-projects-v2-api.md` §5.
- **Comments** = GitHub Projects items don't have their own comment thread; write agent output (e.g. Antigravity's plan) as a comment on the linked Issue/PR, not as a Projects-native comment.

Implement it against the same `PMProvider`-shaped interface Cascade uses (`getWorkItem`, `moveWorkItem`, `addComment`, `listWorkItems`, …) so the router/trigger/dispatch code stays provider-agnostic — see Cascade's `src/pm/types.ts` for the exact interface to mirror.

## Pipeline phases (MVP scope: all four)

Per `PROJECT.md` §5, adapted to GitHub Projects as the board and GitHub as the sole SCM:

1. **Planning** — item enters "Planning" status → worktree provisioned → Antigravity CLI writes `proposed_plan.md` → plan posted as a comment on the linked Issue → item moved to "Ready for Dev" (or equivalent status).
2. **Implementation** — item enters "In Progress" → worktree on the task branch → Claude Code (implementer persona) implements the plan, runs tests, commits, pushes → PR opened, linked back to the Projects item.
3. **Review** — PR opened / check suite completes → Claude Code (reviewer persona) reviews the diff, posts PR review comments — mirrors Cascade's review-agent trigger on `check_suite` success.
4. **Respond to review** — reviewer persona submits a review with `changes_requested` → Claude Code (implementer persona) addresses the batched review comments, pushes a fix, or pushes back with a rationale — mirrors Cascade's `respond-to-review` trigger and its "wait for the final submitted review, not individual line comments" rule.

## Worktree lifecycle

Unchanged from `PROJECT.md` §4 — this part of the original spec is SWARM-specific and already correct:

- Main repo at `~/swarm/{project-name}/`, worktrees under `~/swarm/{project-name}/.swarm-workspaces/task-<id>/`.
- `git worktree add` per task; untracked config/caches (`.env`, `node_modules`, build caches) grafted in via symlinks.
- `git worktree remove --force` on completion.

## Single-user scope

No user-to-device mapping, no per-org config, no multi-tenant Firestore layer. One Postgres row per SWARM project, one set of GitHub credentials (per persona) per project. Revisit if SWARM is ever shared with another user.
