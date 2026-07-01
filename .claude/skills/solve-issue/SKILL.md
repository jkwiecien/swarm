---
name: solve-issue
description: Implements a KANBAN_BOARD.md backlog item end-to-end on a fresh branch off main — implementation, then an independent subagent review posted as a real PR review, then a separate subagent that responds to that review — and opens a PR for human merge.
---

# Solve Issue Skill

## Usage

Trigger with `/solve-issue <issue-id>` — e.g. `/solve-issue 6` or `/solve-issue SWARM-6`. Also trigger by asking to "solve issue 6" / "work SWARM-6" / "pick up issue 6 from the board".

This is a manual, single-persona stand-in for the automated pipeline described in `PROJECT.md` §5.2–§5.4 (Implementation → Review → Respond-to-review) — everything except the Planning phase, which stays out of scope for this skill. Since SWARM's own dual-persona bot setup (`ai/CODING_STANDARDS.md` "Loop prevention") doesn't exist yet, all GitHub actions here happen under whatever `gh` identity is currently active — that's fine because this skill runs once, linearly, on explicit human invocation; it isn't a webhook-triggered loop.

---

## Step-by-step procedure

### Step 0: Confirm identity

Before any GitHub action, run the account check from `ai/RULES.md` §3 (`gh auth status --active` / switch to `jkwiecien` if needed) and make sure the local git author override is set. Don't skip this — it's what keeps commits attributed correctly.

### Step 1: Resolve the issue

1. Normalize the argument to `SWARM-<N>` (accept a bare number or the full id).
2. Find that id's line in `KANBAN_BOARD.md` — check **Backlog** first, then **To do**. If it isn't there, stop and tell the user rather than guessing which task they meant.
3. Read the full task line and any indented note; that's the spec. If it's underspecified and the intent isn't obvious from `PROJECT.md` / `ai/ARCHITECTURE.md`, stop and ask — don't invent scope.

### Step 2: Sync main and branch

1. Confirm the working tree is clean. If there are uncommitted changes unrelated to this task, stop and ask — don't stash or discard someone's in-progress work.
2. Update main from the remote if one exists (don't fail if it doesn't — this repo may not have a remote configured yet):
   ```bash
   git checkout main
   git remote get-url origin >/dev/null 2>&1 && git pull --ff-only origin main || echo "no origin remote (or nothing to pull) — using local main as-is"
   ```
3. Branch from the now-current main:
   ```bash
   git checkout -b swarm-<N>-<kebab-slug-of-the-task-title>
   ```

### Step 3: Move the task to "In progress"

Per `ai/RULES.md` §5: cut the task's line out of its current column in `KANBAN_BOARD.md` and paste it under `## In progress`. Commit this alone:
```bash
git add KANBAN_BOARD.md
git commit -m "docs: move SWARM-<N> to in progress"
```

### Step 4: Implement (you do this directly — no subagent)

1. Read `ai/CODING_STANDARDS.md`, `ai/ARCHITECTURE.md`, and `ai/TESTING.md` before writing any code — this codebase is deliberately styled after Cascade, and those docs explain the conventions to match.
2. Implement the task fully. Keep the diff small and reviewable — resist scope creep beyond what the task line describes; if you notice unrelated follow-up work, add it to `KANBAN_BOARD.md`'s Backlog instead of doing it now.
3. Run lint, typecheck, and the relevant tests per `ai/TESTING.md`. Fix whatever they surface — don't hand this off to review with a red build.
4. Commit the implementation with a conventional-commit message (`feat(...): ...`, `fix(...): ...`).
5. Push and open the PR:
   ```bash
   git push -u origin swarm-<N>-<slug>
   gh pr create --title "SWARM-<N>: <task title>" --body "<summary of the change + link/reference to the KANBAN_BOARD.md item>"
   ```
6. Move the task to "In review" in `KANBAN_BOARD.md` and commit that alone, same as Step 3.

### Step 5: Independent review (subagent)

Spawn a subagent via the Agent tool. Do **not** review the work in this same context — a fresh subagent with no attachment to the implementation is the entire point, same as Cascade's reviewer persona never being the implementer. Give it:

- The PR number/branch, and instructions to read the **full diff** (`gh pr diff <N>` or `git diff main...HEAD`) — not just the commit messages.
- `ai/CODING_STANDARDS.md` and `ai/ARCHITECTURE.md` as the standard to check against.
- Instructions to look for correctness bugs, missed edge cases, deviations from the coding standards, and missing test coverage.
- Instructions to post its findings as a **real GitHub PR review**:
  ```bash
  gh pr review <N> --request-changes --body "<findings>"
  # or, if nothing worth blocking on:
  gh pr review <N> --approve --body "<summary>"
  ```

Wait for it to finish and report back exactly what it posted.

### Step 6: Respond to review (a second, separate subagent)

Spawn another subagent — not the same one, and not you — to act as the implementer responding to that review. Give it:

- The PR number, and instructions to fetch the submitted review and every comment on it (`gh pr view <N> --json reviews,comments` or `gh api repos/{owner}/{repo}/pulls/<N>/reviews`).
- Instructions that for **each** point raised it must either:
  - fix the code, then commit and push the fix, or
  - if the comment is mistaken, reply explaining why (`gh pr comment <N> --body "..."`) rather than silently ignoring it — mirroring the Path A / Path B split in `PROJECT.md` §5.4.
- Instructions to re-run lint/typecheck/tests after any fix, before pushing.
- Instructions to leave the PR in a mergeable state when done — this skill does not loop back into another review round automatically, and does not auto-merge.

### Step 7: Wrap up

1. Report the PR URL, what the reviewer subagent flagged, and how the respond subagent handled each point (fixed vs. pushed back, with rationale).
2. Confirm `KANBAN_BOARD.md` still shows the task in **In review** — leave it there. Only move it to **Done** if the user later confirms the PR was merged.
3. Leave the PR open for a human to merge.
