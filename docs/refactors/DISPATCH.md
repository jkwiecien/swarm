# Durable dispatch refactor

## Purpose

PR #285 replaces the previous split representation of pending pipeline work
with one durable dispatch state machine. It addresses failures in which the
queue, a `runs` row, the Redis pending-continuation registry, and a GitHub
Projects status could disagree about whether work should still start.

The refactor is implemented by `dispatches` in Postgres. A BullMQ job is now a
wake-up for a dispatch record, not the source of truth for the intent to run a
phase.

The detailed state-machine decision and migration semantics are in
[`ADR-002`](../decisions/ADR-002-durable-dispatch-state-machine.md).

## Problems addressed

- A process stop between recording a deferred run and enqueueing its retry
  could leave a retryable run with no future job.
- Project-capacity waits lived in a Redis-only registry and were absent from
  the Queue UI.
- Cancelling queued work removed a BullMQ job but could not reliably prevent a
  retry, slot release, or redelivery from bringing it back.
- Queue state was inferred from several stores, making recovery and operator
  actions ambiguous after a crash or restart.

## Scope

The following paths create, transition, or wake a durable dispatch:

- incoming SCM and PM webhooks;
- synthetic PM dispatches after Planning auto-advances to Implementation and
  for Planning split children;
- follow-up Review after a Respond-to-review fix;
- coalesced Review/check-suite and conflict-resolution rechecks;
- project-capacity waits and continuation priority;
- agent/provider/delivery deferrals and their delayed retries;
- dashboard Retry now, Terminate, Put back, and `swarm queue clear`;
- startup and periodic reconciliation, including import of legacy deferred
  runs and pending continuations.

Every normal worker pickup atomically claims the dispatch before it resolves a
trigger or starts an agent. Terminal dispatches refuse late wake-ups, so an old
job cannot resurrect cancelled, completed, failed, or superseded work.

## Workflow behaviour preserved

This is an orchestration-durability refactor, not a change to pipeline policy.
The following existing options and branches keep their prior semantics:

- Planning and Implementation `autoAdvance` behaviour;
- regular versus `implementationUnplanned` agent configuration, selected from
  whether Planning has already run for the work item;
- review checks policy (`required` and `if-present`);
- `respondToCi.enabled` and its bounded CI-fix loop;
- `respondToReview.skipOnMinors` and the review-verdict safety cap;
- per-project concurrency and optional continuation priority;
- phase/session resumption and the Implementation branch-provisioning
  checkpoint.

## Auto-merge exception

The Review auto-merge follow-up remains a separate durable mechanism. It does
not start an agent phase: its intent is persisted on the Review run and its
deduplicated wake-ups are handled by the dedicated merge-follow-up queue. It
is therefore intentionally outside the `SwarmJob`/`dispatches` model while
retaining durable recovery semantics.

## Non-goals

This change does not implement multi-user authentication, federated-worker
routing, project memberships, worker enrollment, or worker-owner sharing
consent. Those are separate future work described by ADR-001 and issues
#130, #132, #281, and #282.

