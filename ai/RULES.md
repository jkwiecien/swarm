# Swarm — Agent Rules

System prompt and working conventions for AI agents in this repository — the **single source of truth**. Read this in full before writing code. `CLAUDE.md` at the repo root simply points here.

---

## 1. What this project is

**SWARM** is a Local-First, Federated Multi-Agent Framework that automates software engineering workflows: a stateless cloud orchestrator (webhooks, PM-board routing, gRPC control plane) paired with a local daemon (`swarm-cli`) that runs `claude` / `antigravity` CLIs inside isolated Git worktrees on the developer's own machine. Source code never crosses the network — the cloud only ever sees issue metadata, comments, and logs.

**Read `README.md` in full before writing code.** It's the short orientation (architecture at a glance, pipeline phases, security model, status). `PROJECT.md` at the repo root is the full baseline ADD/spec document — read it before implementing anything under `swarm-cloud/` or `swarm-cli/`.

**Keep `README.md` current.** If a change makes anything in `README.md` inaccurate — an architecture shift, a renamed component, a pipeline phase that changed, a status/roadmap item that moved — update `README.md` in the same change. Do not let it drift from the code; a stale README is worse than no README.

**SWARM is based on Cascade.** SWARM's task modelling, webhook ingestion, and CLI-runner patterns take structural inspiration from Cascade's implementation — consult it for architectural precedent whenever a pattern here is underspecified. Resolve it in this order:

1. `cascade` at the repo root — a symlink to the sibling checkout. This is the expected setup; if it's missing, create it: `ln -s ../cascade cascade`.
2. If not symlinked, look for a sibling checkout directly at `../cascade`.
3. If neither exists locally, it's the open-source project at <https://github.com/mongrel-intelligence/cascade> — clone it or read it there.

---

## 2. Engineering conventions

Read before writing code in the relevant area — these encode Cascade's actual conventions, adapted for SWARM, so agents here write code that looks like Cascade's rather than improvising a different style:

- **`ai/CODING_STANDARDS.md`** — language/tooling (TypeScript strict/ESM, Biome), Zod-as-source-of-truth, error handling, naming, the provider/integration module shape, comment density, GitHub loop-prevention.
- **`ai/ARCHITECTURE.md`** — the MVP architecture (local router/queue/worker, no GCP layer yet — a deliberate deviation from `PROJECT.md`'s cloud design), the GitHub SCM and GitHub Projects PM provider shapes, the four pipeline phases, worktree lifecycle.
- **`ai/TESTING.md`** — Vitest conventions, test data factories, git hooks (Lefthook), what "done" means for a change.

Keep these three current the same way `README.md` must stay current (§1): if a change makes one of them inaccurate, update it in the same change.

---

## 3. GitHub

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

## 4. Claude skills → also expose to Antigravity

Whenever asked to create a Claude Code skill, it lives at `.claude/skills/<name>/SKILL.md` as usual — **and** must also be made visible to Antigravity, which reads project-scoped skills from `.agents/skills/<name>/SKILL.md`. Don't duplicate the files; symlink the whole skill folder so there's one copy to maintain:

```bash
mkdir -p .agents/skills
ln -s ../../.claude/skills/<name> .agents/skills/<name>
```

Do this as part of creating the skill, not as a separate follow-up step — a Claude skill isn't "done" until the Antigravity symlink exists.

---

## 5. Task board

The backlog/task board lives in **GitHub Projects**. `KANBAN_BOARD.md`, the stand-in board used before this was wired up, has been removed — its full backlog was migrated to GitHub issues (see below).

- **Board**: <https://github.com/users/jkwiecien/projects/3/views/1> — owner `jkwiecien` (user-level project), project number `3`, project (node) id `PVT_kwHOAC3TF84BcNwD`.
- **Repo**: `jkwiecien/swarm`. Every task is a GitHub issue in this repo, added as an item to project `3`.
- **Status field**: id `PVTSSF_lAHOAC3TF84BcNwDzhW4MKo`, options — `Backlog` (`f75ad846`), `Ready` (`61e4505c`), `In progress` (`47fc9ee4`), `In review` (`df73e18b`), `Done` (`98236657`). `Ready` is this board's equivalent of the old `To do` column.
- **Labels**: each issue also carries a `phase-<N>` label (`phase-0` … `phase-5`) mirroring the old Phase 0–5 groupings, since the project has no native "phase" field.

Interact with the board via `gh` (`gh issue create/list/view`, `gh project item-add`, `gh project item-edit` — see §3 for the account to run these as). Keep it current: when you pick up a task move its Status to **In progress**, to **In review** when a PR is open, and to **Done** once merged. When new work is identified mid-task, file it as a new issue and add it to the project with Status **Backlog** rather than letting it evaporate.

---

## 6. Workflow expectations

- Verify before claiming done — run the relevant lints/type-checks/tests; if something couldn't be run, say so plainly.
- Small, reviewable changes over sweeping rewrites.
- When the SWARM protocol, architecture, or lifecycle is unclear, check `PROJECT.md` first — do not guess message shapes, task types, or pipeline phases.
