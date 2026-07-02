---
name: solve-issue
description: Implements a GitHub issue from the project's GitHub Projects board end-to-end in its own git worktree — implementation, then an independent subagent review posted as a comment on the PR, then a separate subagent that responds to that review in the same PR thread — and opens a PR for human merge.
---

# Solve Issue Skill

## Usage

Trigger with `/solve-issue <issue-number>` — e.g. `/solve-issue 6`. Also trigger by asking to "solve issue 6" / "work issue 6" / "pick up issue 6 from the board".

This is a manual, single-persona stand-in for the automated pipeline described in `PROJECT.md` §5.2–§5.4 (Implementation → Review → Respond-to-review) — everything except the Planning phase, which stays out of scope for this skill. Since SWARM's own dual-persona bot setup (`ai/CODING_STANDARDS.md` "Loop prevention") doesn't exist yet, all GitHub actions here happen under whatever `gh` identity is currently active — that's fine because this skill runs once, linearly, on explicit human invocation; it isn't a webhook-triggered loop.

Each invocation does its work in a **dedicated git worktree**, not the shared working directory — see Step 2. This is what lets you run `/solve-issue 6` and `/solve-issue 9` back to back (or hand them to separate subagents) without one issue's branch checkout stepping on the other's.

---

## Step-by-step procedure

### Step 0: Sync main, then confirm identity

**First thing — before anything else — pull the latest `main`** so every worktree branches off current history and never stale code. From the main repo root:

```bash
git checkout main && git pull --ff-only origin main
```

If there's no remote yet (`git pull` fails with no configured remote), that's fine — carry on with local `main`. If the fast-forward is refused because local `main` has diverged, stop and tell the user rather than force-anything.

Then, before any GitHub action, run the account check from `ai/RULES.md` §3 (`gh auth status --active` / switch to `jkwiecien` if needed) and make sure the local git author override is set. Don't skip this — it's what keeps commits attributed correctly.

### Step 1: Resolve the issue

1. The argument is a bare GitHub issue number in `jkwiecien/swarm`.
2. Fetch it: `gh issue view <N> --repo jkwiecien/swarm --json number,title,body,state,url`. If it doesn't exist, stop and tell the user rather than guessing which task they meant. If it's already closed, confirm with the user before reopening/continuing.
3. Find its project item and current Status (`ai/RULES.md` §5 has the project id/field ids):
   ```bash
   gh project item-list 3 --owner jkwiecien --format json --limit 100 \
     | jq '.items[] | select(.content.number == <N>)'
   ```
   If it isn't on the board, stop and ask. If its Status is already `In progress`, `In review`, or `Done`, confirm with the user before proceeding — someone may already be working it.
4. Read the issue title/body in full; that's the spec. If it's underspecified and the intent isn't obvious from `PROJECT.md` / `ai/ARCHITECTURE.md`, stop and ask — don't invent scope.

### Step 2: Provision a worktree

Per `ai/ARCHITECTURE.md` "Worktree lifecycle": worktrees live under `.swarm-workspaces/` inside the main repo, one per task, so multiple issues can be worked concurrently without touching each other's checkout.

1. `main` is already up to date from Step 0, so branch straight from it. Create the worktree on a fresh branch off `main`, without touching the current checkout:
   ```bash
   git worktree add .swarm-workspaces/issue-<N>-<kebab-slug-of-the-issue-title> -b issue-<N>-<kebab-slug> main
   ```
2. Graft untracked-but-required state into the worktree (symlinks, not copies — per `ai/ARCHITECTURE.md`):
   ```bash
   ln -s "$(pwd)/node_modules" ".swarm-workspaces/issue-<N>-<slug>/node_modules"
   [ -f .env ] && ln -s "$(pwd)/.env" ".swarm-workspaces/issue-<N>-<slug>/.env"
   ```
3. All remaining steps run with CWD set to that worktree path (`cd .swarm-workspaces/issue-<N>-<slug>`), including subagents spawned in Steps 5–6 — give them the absolute worktree path explicitly since they don't inherit your shell CWD.

### Step 3: Move the project item to "In progress"

```bash
gh project item-edit --id <item-id> --project-id PVT_kwHOAC3TF84BcNwD \
  --field-id PVTSSF_lAHOAC3TF84BcNwDzhW4MKo --single-select-option-id 47fc9ee4
```
(`<item-id>` is the `.id` field from the Step 1.3 lookup; ids are documented in `ai/RULES.md` §5.)

### Step 4: Implement (you do this directly — no subagent)

1. Read `ai/CODING_STANDARDS.md`, `ai/ARCHITECTURE.md`, and `ai/TESTING.md` before writing any code — this codebase is deliberately styled after Cascade, and those docs explain the conventions to match.
2. Implement the task fully, inside the worktree. Keep the diff small and reviewable — resist scope creep beyond what the issue describes; if you notice unrelated follow-up work, file it as a new issue and add it to the project board with Status `Backlog` instead of doing it now.
3. Run lint, typecheck, and the relevant tests per `ai/TESTING.md`. Fix whatever they surface — don't hand this off to review with a red build.
4. Commit the implementation with a conventional-commit message (`feat(...): ...`, `fix(...): ...`).
5. Push and open the PR, closing the issue on merge:
   ```bash
   git push -u origin issue-<N>-<slug>
   gh pr create --title "<issue title>" --body "Closes #<N>

   <summary of the change>"
   ```
6. Move the project item's Status to `In review` (same command shape as Step 3, option id `df73e18b`).

### Step 5: Independent review (subagent)

Spawn a subagent via the Agent tool. Do **not** review the work in this same context — a fresh subagent with no attachment to the implementation is the entire point, same as Cascade's reviewer persona never being the implementer. Give it:

- The absolute worktree path to `cd` into, the issue number `<N>`, the PR number/branch, and instructions to read the **full diff** (`gh pr diff <PR>` or `git diff main...HEAD`) — not just the commit messages.
- `ai/CODING_STANDARDS.md` and `ai/ARCHITECTURE.md` as the standard to check against.
- Instructions to look for correctness bugs, missed edge cases, deviations from the coding standards, and missing test coverage.
- Instructions to post its findings as a **plain comment on the PR** (`gh pr comment <PR>`), where they sit alongside the diff being reviewed — matching the Review phase in `ai/ARCHITECTURE.md`, which posts the review on the PR. Use a plain PR comment, **not** a formal GitHub PR review (`gh pr review`): this skill runs under a single `gh` identity, and GitHub refuses to let an author approve or request changes on their own PR, so `gh pr review` would fail here. Lead the comment with a clear verdict line so the respond step and any human can parse it at a glance:
  ```bash
  gh pr comment <PR> --repo jkwiecien/swarm --body "**Review verdict: changes requested** (PR #<PR>)

  <findings>"
  # or, if nothing worth blocking on:
  gh pr comment <PR> --repo jkwiecien/swarm --body "**Review verdict: approved** (PR #<PR>)

  <summary>"
  ```

Wait for it to finish and report back exactly what it posted.

### Step 6: Respond to review (a second, separate subagent)

Spawn another subagent — not the same one, and not you — to act as the implementer responding to that review. Give it:

- The absolute worktree path to `cd` into, the issue number `<N>`, the PR number, and instructions to fetch the review comment posted in Step 5 and any follow-ups (`gh pr view <PR> --repo jkwiecien/swarm --json comments`).
- Instructions that for **each** point raised it must either:
  - fix the code, then commit and push the fix, or
  - if the comment is mistaken, reply explaining why — mirroring the Path A / Path B split in `PROJECT.md` §5.4.
- Instructions to post its response as a **plain comment on the PR** (`gh pr comment <PR>`), point by point, saying for each whether it fixed the code (with the commit) or pushed back (with rationale) — matching where the review was posted:
  ```bash
  gh pr comment <PR> --repo jkwiecien/swarm --body "<point-by-point response>"
  ```
- Instructions to re-run lint/typecheck/tests after any fix, before pushing.
- Instructions to leave the PR in a mergeable state when done — this skill does not loop back into another review round automatically, and does not auto-merge.

### Step 7: Wrap up

1. Report the PR URL, what the reviewer subagent flagged, and how the respond subagent handled each point (fixed vs. pushed back, with rationale).
2. Confirm the project item's Status is still `In review` — leave it there, and leave the worktree in place (don't `git worktree remove` yet — a further review round may still need it).
3. Leave the PR open for a human to merge.

### Step 8: Cleanup (only once the user confirms the PR merged)

Don't do this proactively — only after the user says the PR was merged:

```bash
git worktree remove --force .swarm-workspaces/issue-<N>-<slug>
git branch -d issue-<N>-<slug> 2>/dev/null || true
gh project item-edit --id <item-id> --project-id PVT_kwHOAC3TF84BcNwD \
  --field-id PVTSSF_lAHOAC3TF84BcNwDzhW4MKo --single-select-option-id 98236657
```
The `Closes #<N>` in the PR body auto-closes the issue on merge — no separate `gh issue close` needed.
