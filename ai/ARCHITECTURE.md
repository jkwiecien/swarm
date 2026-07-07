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

Dashboard (Hono HTTP server + tRPC, host process)
   — exposes a `/health` check and mounts a tRPC API under `/trpc`
   — self-hosted, single-process model running locally on the host
```

Redis (for BullMQ) and Postgres (for project config, credentials at rest, and run history — same role it plays in Cascade) run in the same Docker Compose stack as the router. The **worker and the dashboard are the exceptions**: they run directly on the host rather than in containers — the worker because it provisions Git worktrees and spawns the `claude` / `antigravity` CLIs (which need the developer's own PATH, auth, and config), and the dashboard (scaffolded via Hono and tRPC) for local-first, single-process execution. They connect to Redis/Postgres over their published host ports (`REDIS_URL` / `DATABASE_URL` in `.env`). There is no separate "cloud" process for the MVP; router, worker, dashboard, Redis, and Postgres are all local.

### Observability

All code logs through one shared logger (`src/lib/logger.ts`) — a deliberately tiny, dependency-free wrapper (no pino/winston) mirroring Cascade's `logger.info/warn/error/debug(message, context)` shape. It emits **structured JSON** (one `{level,time,msg,...context}` object per line) for machine parsing, or — for a human watching a terminal — a local-clock timestamp, a colored level tag, the bound `component` as a `[component]` prefix, and remaining context as `key=value` pairs (color only on a real TTY, never when `NO_COLOR` is set). Format follows `SWARM_LOG_FORMAT` (`json`|`pretty`) and auto-picks pretty on an interactive TTY, json when piped/containerized — **leave it unset** in `.env` rather than hardcoding either value: the router's own `docker-compose.yml` environment block already pins it to `json` for that container regardless of `.env`, so setting it in `.env` only ends up overriding the host worker's auto-detection (and silently losing pretty/color) without changing the router at all. `SWARM_LOG_LEVEL` (`debug|info|warn|error`, default `info`) sets the minimum emitted level. Because router and worker share a log stream, each entry point calls `configureLogger({ component })` at startup so every line it emits is tagged `component: "router"` / `"worker"` and stays attributable.

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

## Pipeline phases

Per `PROJECT.md` §5, adapted to GitHub Projects as the board and GitHub as the sole SCM:

1. **Planning** — item enters "Planning" status → worktree provisioned → the planning agent writes `proposed_plan.md` → plan posted as a comment on the linked Issue. The item stays in "Planning" — this phase never moves it; a human reviews the plan, then moves the item to "ToDo" themselves to greenlight Implementation.
2. **Implementation** — item enters "ToDo" → the phase moves it to "In Progress" to report the pickup (a status report, not a trigger) → worktree on the task branch → Claude Code (implementer persona) implements the plan, runs tests, commits, pushes → PR opened, linked back to the Projects item.
3. **Review** — PR opened / check suite completes with all checks passing → Claude Code (reviewer persona) reviews the diff, posts PR review comments — mirrors Cascade's review-agent trigger on `check_suite` success.
4. **Respond to review** — reviewer persona submits any non-approving review (`changes_requested` or a plain `commented` review) → Claude Code (implementer persona) addresses the batched review comments, pushes a fix, or pushes back with a rationale — mirrors Cascade's `respond-to-review` trigger and its "wait for the final submitted review, not individual line comments" rule.
5. **Respond to CI** — a PR's check suite completes with a failing check → worktree on the PR's task branch → Claude Code (implementer persona) inspects the failing checks, fixes the build surgically and pushes (or reports no code change was warranted) — mirrors Cascade's `respond-to-ci` agent. A per-PR fix-attempt cap stops a never-sticking fix from looping (each fix commit is a new SHA, so it re-triggers CI).

### Trigger wiring (SWARM-53)

The phases are self-contained orchestrators; the trigger registry (`src/triggers/`) is what connects inbound events to them. `registerBuiltInTriggers` (`src/triggers/builtins.ts`) registers three handlers under `src/triggers/handlers/`:

- **`pm-status-changed`** — one handler for both PM-driven phases. On a `projects_v2_item` Status edit (or a card added), it re-reads the item authoritatively via the `PMProvider` (never trusting the webhook's Status value — `docs/github-projects-v2-api.md` §5) and, per `resolvePipelinePhaseForOptionId`, starts Planning (→ Planning) or Implementation (→ ToDo), or returns `null` for any other status — including "In progress", which Implementation itself moves an item *to* as a status report, not a trigger. The Board view's drag-and-drop actually fires a `reordered` action (no `changes.field_value` at all — a real delivery confirmed this), not `edited`, so the adapter accepts both; a Redis-backed dedup (`pm-status-dedup.ts`) stops the resulting harmless within-column reorders from re-dispatching the same phase.
- **`pr-review`** — the PR-lifecycle handler. Starts Review on a non-draft, **same-repo**, **SWARM-authored** PR opening or its checks passing, and routes a *failing* check suite to Respond-to-CI. On a `check_suite` completion it re-queries *every* check on the head SHA (`getCheckSuiteStatus`) rather than trusting the single suite's own conclusion — GitHub fires one event per workflow — and decides via `check-suite-decision.ts`: review if all complete and none failed, **respond-to-ci** if a check failed, or **defer** if a check is still running, scheduling a coalesced ~30s recheck (`scheduleCoalescedJob`) that re-queries fresh state (a `recheckAttempt` cap bounds the loop against a stale Actions API). Fork PRs are dropped from the Review path (their head SHA is unreachable for the detached review checkout). An **author-persona gate** reviews only PRs authored by a SWARM persona (the implementer opens every SWARM PR), mirroring Cascade's `decideCheckSuiteGates` default `authorMode='own'`, so a human- or third-party-bot-authored PR never burns a review; on the `check_suite` path the gate runs *before* the aggregate query (one `pulls.get`, since that payload carries no author) so a PR we'd never review doesn't also pay the heavier Actions-API call. The respond-to-ci dispatch reuses the same per-SHA dedup slot (review and respond-to-ci are mutually exclusive for a commit) and adds a per-PR fix-attempt cap (`respond-to-ci-attempts.ts`) so a fix that never makes CI green can't loop forever.
- **`pr-review-submitted`** — starts Respond-to-review on a `pull_request_review` `submitted` that isn't an approval and is authored by the *reviewer* persona (`getPersonaForLogin`).

A matched handler returns a `TriggerResult` naming the phase plus its resolved inputs; the worker's `processJob` (`src/worker/consumer.ts`) dispatches on that phase and calls the matching `runXPhase`, building the concrete GitHub Projects `PMProvider` (`src/integrations/pm/github-projects/provider.ts`) for the two board-driven phases. The review handler is guarded by a cross-process dedup claim (`src/triggers/review-dispatch-dedup.ts`, SWARM-62): a Redis `SET NX EX` keyed on `owner/repo:pr:headSha`, claimed before dispatch and left to expire by TTL (nothing releases it on failure in the MVP), so a PR that opens *and* then passes checks (or emits several check-suite successes) is reviewed once per commit rather than once per event. It fails closed — a claim it can't obtain (duplicate, or Redis down) skips the dispatch — and the respond-to-ci path shares that same slot before its own attempt cap runs.

## Worktree lifecycle

Unchanged from `PROJECT.md` §4 — this part of the original spec is SWARM-specific and already correct:

- Main repo at `~/swarm/{project-name}/`, worktrees under `~/swarm/{project-name}/.swarm-workspaces/task-<id>/`.
- `git worktree add` per task; config/caches and the `cascade` sibling-checkout pointer (`.env`, `node_modules`, `cascade`, build caches) grafted in via symlinks with **absolute** targets — a relative link would dangle at the worktree's `.swarm-workspaces/<name>/` depth (see `ai/RULES.md` §1).
- `git worktree remove --force` on completion.

## Harness (agent-CLI execution engine)

Once the worker has a provisioned worktree, it hands off to the harness (`src/harness/agent-cli.ts`, `runAgentCli`) to actually run the agent. The harness is deliberately narrow: it spawns `claude` or `antigravity` (Node's `child_process.spawn`, no subprocess library) with the worktree as CWD, streams stdout/stderr line-by-line (optional callbacks + `logger.debug`) while accumulating the full output, and resolves with `{ exitCode, signal, stdout, stderr, durationMs, timedOut }`. A non-zero exit is a normal outcome the caller inspects — only a spawn failure (e.g. the CLI isn't installed) throws. `timeoutMs` and an `AbortSignal` both kill the run (SIGTERM, escalating to SIGKILL). Prompt construction, persona/token selection, and the queue→worktree→harness→cleanup lifecycle live in the worker (SWARM-17), not here.

### Failure handling & rate-limit retries (issue #91)

A phase whose agent exits non-zero throws, and `processJob` turns that into a `phase-failed` `JobOutcome` rather than rethrowing — an agent run isn't idempotent, so a BullMQ retry storm is worse than surfacing the failure (the phase already logged the agent's stdout/stderr, and the `attempts: 3` default only ever fires for the infra throws that happen *before* the agent runs). The one exception is a transient **usage/session-limit** hit: the agent never did any work, so re-running the phase later is both safe and desirable. `src/harness/agent-failure.ts` classifies a failed run (`classifyAgentFailure` → `rate-limit` | `timeout` | `error`, parsing the CLI's own "resets …" hint into an absolute `retryAfter` best-effort) and phases throw an `AgentRunError` carrying that classification. On a `rate-limit` error `processJob` returns a `phase-deferred` outcome with a computed delay instead of `phase-failed`; the worker entrypoint (`src/worker/index.ts`) re-enqueues the job (delayed, fresh job id, `rateLimitRetryAttempt` bumped) via `enqueueDelayedRetry`, capped so a persistent limit eventually fails for real. The retry delay is floored above the review-dispatch-dedup TTL so a deferred review re-acquires its claim cleanly rather than being skipped as a duplicate.

## Single-user scope

No user-to-device mapping, no per-org config, no multi-tenant Firestore layer. One Postgres row per SWARM project, one set of GitHub credentials (per persona) per project. Revisit if SWARM is ever shared with another user.
