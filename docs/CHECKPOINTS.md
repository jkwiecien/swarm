# Checkpointed agent runs (deferred design)

This document describes a possible future quota-control mechanism. It is **not
implemented** and does not change current timeout, retry, worktree, or run-status
behaviour.

## Goal

Budgets should prevent an agent from expanding a task indefinitely without throwing
away useful work when it is close to finishing. A checkpoint is therefore a safe
handoff point, not a hard token-limit termination.

## Proposed lifecycle

1. A phase runs with a soft quota budget and a small completion reserve.
2. At the soft threshold, the agent stops starting broad investigation, refactors,
   or new optional work. It decides whether it can finish verification and its
   phase handoff within the reserve.
3. If it can, it receives one bounded grace period and completes normally. If it
   cannot, it writes a structured checkpoint file and exits cleanly at a safe
   boundary (never in the middle of an edit or command).
4. SWARM keeps the branch and worktree, marks the run as checkpointed, and queues
   a continuation. Where supported, it also retains the agent session.
5. The continuation validates the actual worktree, reads the checkpoint first,
   and completes only the recorded remainder. It must not re-explore or redesign
   completed work unless verification demonstrates that it is necessary.

## Checkpoint contents

The handoff should be short and factual:

```md
# Implementation checkpoint

## Completed
- Added `ProjectConfigSchema.retryPolicy` and focused validation tests.

## Remaining
- Update the README configuration table.
- Run lint, type-check, and `tests/unit/config/schema.test.ts`.
- Commit, push, and open the PR.

## Decisions / caveats
- Storage-migration coverage is out of scope for this item.

## Working-tree state
- Modified: `src/config/schema.ts`, `tests/unit/config/schema.test.ts`
```

## Required future work

- Add a checkpointed run status and durable continuation job.
- Define phase-specific soft budgets, reserves, and maximum continuation count.
- Preserve worktree leases and agent sessions through a checkpoint.
- Validate the checkpoint file and working tree before continuation.
- Add dashboard visibility and an operator action to continue or terminate.
