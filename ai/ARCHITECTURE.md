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
Worker  (host process — NOT containerized, one job at a time or a small pool)
   — looks up the trigger handler for the event
   — provisions a Git worktree (see "Worktree lifecycle" below)
   — spawns `claude` or `antigravity` CLI with the worktree as CWD
   — commits/pushes, opens/updates a PR, posts back to GitHub Projects
```

Redis (for BullMQ) and Postgres (for project config, credentials at rest, and run history — same role it plays in Cascade) run in the same Docker Compose stack as the router. The **worker is the exception**: it provisions Git worktrees and spawns the `claude` / `antigravity` CLIs, which need the developer's own PATH, auth, and config, so it runs directly on the host (`npm run dev:worker`) rather than in a container — reaching Redis/Postgres over their published host ports. There is no separate "cloud" process for the MVP; router, worker, Redis, and Postgres are all local.

### Observability

All code logs through one shared logger (`src/lib/logger.ts`) — a deliberately tiny, dependency-free wrapper (no pino/winston) mirroring Cascade's `logger.info/warn/error/debug(message, context)` shape. It emits **structured JSON** (one `{level,time,msg,...context}` object per line) for machine parsing, or a readable `[level] msg {context}` form for local dev; format follows `SWARM_LOG_FORMAT` (`json`|`pretty`) and auto-picks pretty on an interactive TTY, json when piped/containerized. `SWARM_LOG_LEVEL` (`debug|info|warn|error`, default `info`) sets the minimum emitted level. Because router and worker share a log stream, each entry point calls `configureLogger({ component })` at startup so every line it emits is tagged `component: "router"` / `"worker"` and stays attributable.

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
4. **Respond to review** — reviewer persona submits any non-approving review (`changes_requested` or a plain `commented` review) → Claude Code (implementer persona) addresses the batched review comments, pushes a fix, or pushes back with a rationale — mirrors Cascade's `respond-to-review` trigger and its "wait for the final submitted review, not individual line comments" rule.

### Trigger wiring (SWARM-53)

The phases are self-contained orchestrators; the trigger registry (`src/triggers/`) is what connects inbound events to them. `registerBuiltInTriggers` (`src/triggers/builtins.ts`) registers three handlers under `src/triggers/handlers/`:

- **`pm-status-changed`** — one handler for both PM-driven phases. On a `projects_v2_item` Status edit (or a card added), it re-reads the item authoritatively via the `PMProvider` (never trusting the webhook's Status value — `docs/github-projects-v2-api.md` §5) and, per `resolvePipelinePhaseForOptionId`, starts Planning (→ Planning) or Implementation (→ In progress), or returns `null` for any other status.
- **`pr-review`** — starts Review on a non-draft, **same-repo** PR opening or its check suite completing with `success`. Fork PRs are dropped (their head SHA is unreachable for the detached review checkout).
- **`pr-review-submitted`** — starts Respond-to-review on a `pull_request_review` `submitted` that isn't an approval and is authored by the *reviewer* persona (`getPersonaForLogin`).

A matched handler returns a `TriggerResult` naming the phase plus its resolved inputs; the worker's `processJob` (`src/worker/consumer.ts`) dispatches on that phase and calls the matching `runXPhase`, building the concrete GitHub Projects `PMProvider` (`src/integrations/pm/github-projects/provider.ts`) for the two board-driven phases. The review handler is guarded by a cross-process dedup claim (`src/triggers/review-dispatch-dedup.ts`, SWARM-62): a Redis `SET NX EX` keyed on `owner/repo:pr:headSha`, claimed before dispatch and released if the Review phase fails, so a PR that opens *and* then passes checks (or emits several check-suite successes) is reviewed once per commit rather than once per event. It fails closed — a claim it can't obtain (duplicate, or Redis down) skips the dispatch. Deliberately deferred vs Cascade (filed as follow-ups): check-suite incomplete-check recheck, and a respond-to-ci path.

## Worktree lifecycle

Unchanged from `PROJECT.md` §4 — this part of the original spec is SWARM-specific and already correct:

- Main repo at `~/swarm/{project-name}/`, worktrees under `~/swarm/{project-name}/.swarm-workspaces/task-<id>/`.
- `git worktree add` per task; config/caches and the `cascade` sibling-checkout pointer (`.env`, `node_modules`, `cascade`, build caches) grafted in via symlinks with **absolute** targets — a relative link would dangle at the worktree's `.swarm-workspaces/<name>/` depth (see `ai/RULES.md` §1).
- `git worktree remove --force` on completion.

## Harness (agent-CLI execution engine)

Once the worker has a provisioned worktree, it hands off to the harness (`src/harness/agent-cli.ts`, `runAgentCli`) to actually run the agent. The harness is deliberately narrow: it spawns `claude` or `antigravity` (Node's `child_process.spawn`, no subprocess library) with the worktree as CWD, streams stdout/stderr line-by-line (optional callbacks + `logger.debug`) while accumulating the full output, and resolves with `{ exitCode, signal, stdout, stderr, durationMs, timedOut }`. A non-zero exit is a normal outcome the caller inspects — only a spawn failure (e.g. the CLI isn't installed) throws. `timeoutMs` and an `AbortSignal` both kill the run (SIGTERM, escalating to SIGKILL). Prompt construction, persona/token selection, and the queue→worktree→harness→cleanup lifecycle live in the worker (SWARM-17), not here.

## Single-user scope

No user-to-device mapping, no per-org config, no multi-tenant Firestore layer. One Postgres row per SWARM project, one set of GitHub credentials (per persona) per project. Revisit if SWARM is ever shared with another user.
