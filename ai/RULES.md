# Swarm — Agent Rules

System prompt and working conventions for AI agents in this repository — the **single source of truth**. Read this in full before writing code. `CLAUDE.md` at the repo root simply points here.

---

## 1. What this project is

**SWARM** is a Local-First, Federated Multi-Agent Framework that automates software engineering workflows: a stateless cloud orchestrator (webhooks, PM-board routing, gRPC control plane) paired with a local daemon (`swarm-cli`) that runs `claude` / `antigravity` CLIs inside isolated Git worktrees on the developer's own machine. Source code never crosses the network — the cloud only ever sees issue metadata, comments, and logs.

**Read `README.md` in full before writing code.** It's the short orientation (architecture at a glance, pipeline phases, security model, status). `PROJECT.md` at the repo root is the full baseline ADD/spec document — read it before implementing anything under `swarm-cloud/` or `swarm-cli/`.

**Keep `README.md` current.** If a change makes anything in `README.md` inaccurate — an architecture shift, a renamed component, a pipeline phase that changed, a status/roadmap item that moved — update `README.md` in the same change. Do not let it drift from the code; a stale README is worse than no README.

**SWARM is based on Cascade.** SWARM's task modelling, webhook ingestion, and CLI-runner patterns take structural inspiration from Cascade's implementation — consult it for architectural precedent whenever a pattern here is underspecified. Resolve it in this order:

1. `cascade` at the repo root — a symlink to the sibling checkout. This is the expected setup; if it's missing, create it with an **absolute** target: `ln -sfn "$(cd ../cascade && pwd -P)" cascade`. (Use an absolute target, not a relative `../cascade`: git worktrees under `.swarm-workspaces/<name>/` check out the same committed symlink two levels deeper, where a relative `../cascade` dangles. The per-worktree `node_modules` symlink is grafted at runtime with an absolute target for the same reason.)
2. If not symlinked, look for a sibling checkout directly at `../cascade`.
3. If neither exists locally, it's the open-source project at <https://github.com/mongrel-intelligence/cascade> — clone it or read it there.

---

## 2. Engineering conventions

Read before writing code in the relevant area — these encode Cascade's actual conventions, adapted for SWARM, so agents here write code that looks like Cascade's rather than improvising a different style:

- **`ai/CODING_STANDARDS.md`** — language/tooling (TypeScript strict/ESM, Biome), Zod-as-source-of-truth, error handling, naming, the provider/integration module shape, comment density, GitHub loop-prevention.
- **`ai/ARCHITECTURE.md`** — the MVP architecture (local router/queue/worker, no GCP layer yet — a deliberate deviation from `PROJECT.md`'s cloud design), the GitHub SCM and GitHub Projects PM provider shapes, the pipeline phases, worktree lifecycle.
- **`ai/TESTING.md`** — Vitest conventions, test data factories, git hooks (Lefthook), what "done" means for a change.
- **`ai/DESIGN_SYSTEM.md`** — color/typography/spacing tokens and component patterns (buttons, forms, tables, tabs, modals, banners) for the web dashboard (`web/`, the phase-6 issues in §5). Read before building any dashboard screen.

Keep these current the same way `README.md` must stay current (§1): if a change makes one of them inaccurate, update it in the same change.

### Project-management features must stay provider-agnostic

Today SWARM's only PM provider is **GitHub Projects**, but Jira, Linear, and Trello connectors are planned (Cascade already ships all three — it's the structural precedent per §1). **Every feature that touches the project board must be built behind the provider-agnostic `PMProvider` interface (`src/pm/types.ts`), never against GitHub Projects directly**, so a new connector drops in by implementing that interface alone — no pipeline, trigger, or phase code changes.

Concretely:

- **Program against `PMProvider`, not the concrete provider.** Pipeline phases, triggers, and the worker take a `PMProvider` (or have one injected) and call only its interface methods (`getWorkItem`, `listWorkItems`, `moveWorkItem`, `addComment`). They must not import `createGitHubProjectsProvider` or reach into `src/integrations/pm/github-projects/` — only the composition root (`src/worker/consumer.ts`) names the concrete provider.
- **Speak canonical status keys, not board option IDs.** Pipeline/phase/trigger code uses the canonical `PmStatusKey`s (`backlog`, `planning`, `todo`, `inProgress`, `inReview`, `done` — `src/pm/pipeline.ts`); translating those to a provider's opaque option IDs (GitHub's `SingleSelectOptionId`, a Jira transition, a Trello list) is the adapter's job and stays inside the provider.
- **Keep provider-specific shapes out of shared code.** No GitHub-issue-URL parsing, `projects_v2` payload assumptions, or GraphQL node IDs leaking into pipeline/trigger logic. When a piece of data is provider-specific, resolve it through a `PMProvider` method or the work item's generic fields (`id`, `url`, `status`), not by pattern-matching a GitHub shape. (Example: `src/pipeline/respond-to-review.ts` resolves its board card via `listWorkItems()` + the generic `url` field, so it works unchanged for any provider.)
- **If the four-method interface is too small for a feature, widen the interface** (add a method to `PMProvider` and implement it for every provider), rather than special-casing GitHub Projects at the call site. Mirror Cascade's `src/pm/types.ts` when deciding the method shape.

The same "don't build it speculatively" rule (`ai/CODING_STANDARDS.md`) still applies — don't add Jira/Linear/Trello providers until they're needed — but whatever you build for GitHub Projects now must not *assume* it's the only provider.

### Source-control features must not hard-code GitHub

Same story on the SCM side: **GitHub is SWARM's only source-control provider today, but Bitbucket and GitLab are planned.** Unlike the PM side, the SCM integration is *not* yet behind a clean interface — it was ported close to verbatim from Cascade (`ai/ARCHITECTURE.md` "SCM = GitHub … copy this piece close to verbatim"), so `GitHubSCMIntegration` (`src/integrations/scm/github/scm-integration.ts`) is currently concrete. That's an accepted MVP shortcut, **not licence to spread GitHub-specific naming and assumptions through the rest of the codebase.** Build SCM features so a future `SCMProvider` interface (and Bitbucket/GitLab providers beside GitHub) can be introduced without a rename sweep:

- **Keep GitHub specifics inside `src/integrations/scm/github/` and the router adapter (`src/router/adapters/github.ts`).** GraphQL node IDs, `check_suite`/`pull_request_review` webhook payload shapes, `gh` CLI invocations, and GitHub REST/GraphQL calls live there — not in pipeline, trigger, or worker code, which should speak in domain terms and take the integration as a dependency.
- **Name SCM features by the domain concept, not the GitHub vocabulary.** Prefer provider-neutral names — "pull request" / "review" / "check run" / "comment" / "default branch" — over GitHub-only wording, in identifiers, config keys, and log messages. (GitLab calls a PR a "merge request"; a provider-neutral `pullRequest`/`changeRequest` name at the seam saves a later rename.) Provider-specific vocabulary (`check_suite`, `projects_v2`, a `gh` subcommand) is fine *inside* the GitHub module, not in the shared surface.
- **When you'd reach for a GitHub client in shared code, add a seam instead.** If a pipeline/trigger needs an SCM operation the current code exposes only as a raw GitHub call, factor it into a provider-neutral method on the integration (the same "widen the interface, don't special-case" move as the PM rule) so a second provider can implement it — rather than importing the GitHub client at the call site.
- **New per-provider code goes under `src/integrations/scm/<provider>/`**, mirroring the existing `github/` folder and the `pm/<provider>/` layout, so the directory structure already anticipates the second and third providers.

As above, don't *build* Bitbucket/GitLab providers until they're needed — just don't write GitHub assumptions into places a second provider would then have to unpick.

---

## 3. GitHub

> **Scope: interactive/human-driven sessions only — NOT SWARM pipeline agents.** This
> section is for an agent working *on* SWARM as a stand-in for the human contributor
> `jkwiecien`. It does **not** apply to SWARM's own pipeline personas (the
> Implementation / Review / Respond-to-review / Respond-to-CI agents the worker spawns
> inside `.swarm-workspaces/`). Those are authenticated by the worker via a persona
> `GH_TOKEN` (`src/pipeline/*.ts`) and **must not** run `gh auth switch`/`login`/`logout`,
> touch `GH_TOKEN`, or change commit attribution — doing so posts their work under the
> wrong identity and breaks the pipeline (their prompts carry `GH_IDENTITY_GUARD` from
> `src/pipeline/agent-auth.ts` telling them to ignore this section). If you were spawned
> by the SWARM worker, skip the rest of §3 entirely.

- **Always interact with GitHub through the `gh` CLI** (PRs, issues, reviews, merges, releases) — not the web UI or raw API.
- **Contribute as the `jkwiecien` account.** Before any GitHub operation, verify the active account and switch if needed:

  ```bash
  gh auth status --active 2>&1 | grep -q 'account jkwiecien$' || gh auth switch --user jkwiecien
  ```

  (`gh auth switch --user jkwiecien` flips gh's active account when it's currently on `jkwiecien-solvd` or anything else.)
- **Commit attribution must also be `jkwiecien`** — gh's account only governs the API. GitHub's contribution graph follows the commit *email*. Set a **local** git author override (in `.git/config`, not committed) before committing:

  ```bash
  git config --local user.name "Jacek Kwiecien"
  git config --local user.email "jacek.kwiecien@gmail.com"
  ```

  If a commit ever resolves to `jkwiecien@solvd.com` (the global default), the local override is missing or was reset — restore it before committing.

  Without this, PRs are opened by `jkwiecien` but commits stay attributed to SOLVD.

---

## 4. Project skills → expose to Claude, Antigravity, and Codex

Whenever asked to create a project skill, keep its canonical copy at `.claude/skills/<name>/SKILL.md` as usual — **and** make it visible to both Antigravity and Codex through their shared project-scoped skills path, `.agents/skills/<name>/SKILL.md`. Don't duplicate the files; symlink the whole skill folder so there's one copy to maintain:

```bash
mkdir -p .agents/skills
ln -s ../../.claude/skills/<name> .agents/skills/<name>
```

Do this as part of creating the skill, not as a separate follow-up step — a project skill isn't "done" until the `.agents/skills` symlink exists and the same skill is available to all three agents: Claude, Antigravity, and Codex.

---

## 5. Task board

The backlog/task board lives in **GitHub Projects**. `KANBAN_BOARD.md`, the stand-in board used before this was wired up, has been removed — its full backlog was migrated to GitHub issues (see below).

- **Historical board**: <https://github.com/users/jkwiecien/projects/3/views/1> — owner `jkwiecien` (user-level project), project number `3`, project (node) id `PVT_kwHOAC3TF84BcNwD`. Holds the full backlog history (phase-0 … phase-5, all issues through #86). Kept as-is for reference; **SWARM's live config no longer points here** because a user-owned Projects (v2) board cannot receive the `projects_v2_item` webhook event GitHub requires for the Status-changed trigger (`docs/github-projects-v2-api.md` §5) — there is no plain user-account webhook for it.
- **Live board**: <https://github.com/orgs/SmartTechBrewery/projects/6/views/1> — owner `SmartTechBrewery` (org-level project), project number `6`, project (node) id `PVT_kwDODb1Ycc4Bcnwu`. Org-owned so a plain org webhook can deliver `projects_v2_item`. Currently holds only the `phase-6` web-dashboard issues (#75–86), copied over from project `3` as the MVP dogfooding test set — it is not (yet) the full backlog. The repo itself stays at `jkwiecien/swarm`; a project's owner and its items' repo don't need to match.
- **Repo**: `jkwiecien/swarm`. Every task is a GitHub issue in this repo. New/active work gets added to project `6` (live); project `3` is not actively maintained going forward.
- **Every newly created issue must be added to the live board immediately and assigned Status `Backlog`.** Do this as part of creating the issue (not as a follow-up); move it out of Backlog only when work is deliberately started.
- **Record issue dependencies, not only prose dependencies.** When creating multiple tasks that depend on one another, use GitHub's native **Blocked by** relationship wherever it is available: mark the dependent issue as blocked by every prerequisite, in addition to any explanatory text in its body. When a newly created issue is a prerequisite for work already known on the board, review those known issues immediately and add the corresponding **Blocked by** relationship wherever it applies. This keeps the board and scheduler from treating an unbuildable task as ready.
- **Keep the live board in proposed execution order.** The manual order of issues within each Status column must represent the intended development sequence: prerequisites come before the tasks they block, then order independent work by agreed priority. Whenever issues or dependency relationships are created, removed, or materially changed, review and update that order rather than leaving backlog priority implicit or stale.
- **Status field** (project `6`): id `PVTSSF_lADODb1Ycc4BcnwuzhXPKyM`, options — `Backlog` (`f75ad846`), `Planning` (`3fe662f4`), `Ready` (`61e4505c` — SWARM's `todo` key; PROJECT.md's "Ready for Dev"), `In progress` (`47fc9ee4`), `In review` (`df73e18b`), `Done` (`98236657`).
- **Labels**: each issue also carries a `phase-<N>` label (`phase-0` … `phase-6`) since the project has no native "phase" field. `phase-0` … `phase-5` mirror the old Phase 0–5 groupings; `phase-6` (Web dashboard) was added later for the dashboard/credential-UI backlog.

Interact with the board via `gh` (`gh issue create/list/view`, `gh project item-add`, `gh project item-edit` — see §3 for the account to run these as). Keep it current: when you pick up a task move its Status to **Planning** while you scope it, to **In progress** once you start implementing, to **In review** when a PR is open, and to **Done** once merged. When new work is identified mid-task, file it as a new issue and add it to the project with Status **Backlog** rather than letting it evaporate.

---

## 6. Workflow expectations

- Verify before claiming done — run the relevant lints/type-checks/tests; if something couldn't be run, say so plainly.
- Small, reviewable changes over sweeping rewrites.
- When the SWARM protocol, architecture, or lifecycle is unclear, check `PROJECT.md` first — do not guess message shapes, task types, or pipeline phases.
- **Recovering a missed Respond-to-review dispatch:** do this only with explicit user authorization and only after verifying the exact submitted reviewer-persona review, PR branch, review ID, and reviewed head SHA. Prefer redelivering the original GitHub `pull_request_review` webhook (`submitted`) through GitHub. If the local `gh` token lacks the required `admin:repo_hook` scope, enqueue one synthetic `github` job carrying the same normalized event fields (`workItemId`, `actorLogin`, `prBranch`, `reviewState`, `reviewId`, and `headSha` from the review's `commit_id`) — omit the old delivery ID so BullMQ does not deduplicate it. Never fabricate a review or replay an event when a Respond-to-review run for that PR is already queued/running; verify the new run is dispatched afterward.
- **Don't assume a new agent-CLI harness has identical flag semantics to `claude`'s, even when a flag name matches.** Two CLIs can expose the same-named flag with different parsing behavior: `claude`'s `-p`/`--print` is a bare boolean (its position among other flags doesn't matter — the prompt is a separate positional argument), while Antigravity's `agy -p`/`--print`/`--prompt` is a *value* flag whose value is the prompt itself — a flag landing between `-p` and the prompt gets swallowed as the prompt instead of the real task, and the CLI still exits 0 having done nothing (confirmed live on a failed Implementation run; see the `DEFAULT_ARGS`/`PRINT_FLAG` comment in `src/harness/agent-cli.ts`). The *process model* can differ too: `agy --print` runs the agent from its own scratch dir (`~/.gemini/antigravity-cli/scratch`), **not** the `cwd` SWARM spawns it with — so, unlike `claude`/`codex`, it can't see the task worktree by inheriting `cwd`. The harness therefore passes `--add-dir <worktree>` for Antigravity, and the phase prompt names the worktree's absolute path so all edits and hand-off files land where SWARM's delivery validation looks (issue #226; see the `addDirArgs` comment in `src/harness/agent-cli.ts`). Verify a new harness's actual argument-parsing behavior against its own `--help` and a real invocation — never infer it from Claude's shape.

---

## 7. Configuration

Every configuration option — general/host settings (environment variables) and per-project config (`swarm.config.json`) — is catalogued in **[`README.md` § Configuration](../README.md#configuration)**. That section is the canonical human-facing reference: exact keys, defaults, required-ness, and the file each lives in.

- **When the user asks you to change a setting** (rather than doing it in the dashboard UI), use that catalogue: find the option there, then edit the right place — `.env` for a general setting, `swarm.config.json` for project config (and remind them to run `swarm config apply` / `npm run db:seed` to load it into Postgres, since the running services read config from the DB, not the file). Don't hunt through source to rediscover an option the catalogue already lists.
- **Keep the catalogue current** — same rule as `README.md`/the `ai/*.md` docs (§1, §2): whenever a change adds, removes, renames, or re-defaults a config option (an env var, a `ProjectConfig` field, a provider-schema field), update the matching row in `README.md`'s Configuration section **in the same change**. The Zod schema in `src/config/schema.ts` stays the source of truth for validation; the README section is its human-readable mirror and must not drift from it.
