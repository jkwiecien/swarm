# Agent quota optimization

This document describes ways to reduce the quota consumed by successful Planning,
Implementation, and Review runs. It deliberately does not repeat the interrupted-run
preservation and continuation design in [`CHECKPOINTS.md`](./CHECKPOINTS.md): checkpoints
reduce work lost when a run stops, while the measures below reduce the amount of work a
normal uninterrupted pipeline performs in the first place.

The governing principle is to spend model quota on decisions that require model judgment.
Repository discovery, phase hand-offs, delivery mechanics, and repeated context collection
should be made reusable or deterministic wherever practical.

## 1. Reuse Planning's analysis in Implementation

Today Planning explores the repository and writes a prose `proposed_plan.md`. Implementation
reads the issue and posted plan, but its prompt then tells it to explore the repository again.
That repeats a meaningful part of Planning's input and tool use in a fresh session.

Planning should instead produce a compact, structured implementation packet containing:

- relevant files, symbols, and existing patterns;
- the ordered changes to make;
- acceptance criteria and intentional exclusions;
- focused verification commands;
- important decisions, risks, and unresolved questions.

SWARM should carry this packet directly into the Implementation job rather than requiring
Implementation to recover it from an issue comment. The human-readable Markdown plan can
still be posted to the issue. Implementation should validate that the packet still matches
the checkout, investigate only gaps or stale assumptions, and avoid redesigning completed
Planning work without evidence that it is necessary.

This is expected to be one of the largest per-task savings because it removes duplicated
repository exploration while retaining a separate human-reviewable Planning phase.

## 2. Avoid standalone Planning for tasks that do not need it

Not every work item benefits enough from a separate architect session to justify a full
additional run. Add a project-level Planning policy:

- `required` — retain the current separate Planning phase;
- `auto` — require or skip standalone Planning using deterministic task signals;
- `disabled` — let Implementation begin with a short, bounded local plan.

The initial `auto` policy should not invoke a classifier model, since that would consume
quota merely to decide whether to consume quota. Deterministic signals can include labels,
task wording, named files, affected areas, and explicit acceptance criteria. Planning should
normally remain required for architecture changes, migrations, cross-package work,
configuration/lifecycle changes, security-sensitive work, and broad or ambiguous tasks. It
can normally be skipped for narrow bug fixes, documentation-only changes, and well-specified
tasks that identify both the target and acceptance criteria.

The policy and its reasons should be visible on the run/task so operators can audit routing
decisions and override them.

## 3. Plan every split child in the original Planning run

With automatic splitting enabled, the parent Planning run has already explored the
repository and decided how the work decomposes. It currently emits a detailed plan only for
the first task and descriptions for the remaining children. Each child enters Planning and
performs another complete repository exploration.

Instead, the original run should produce a concise implementation plan for every child while
its repository context is still available. Each child should receive:

- a self-contained title and scope;
- acceptance criteria and exclusions;
- relevant files/symbols and dependencies on preceding children;
- an ordered implementation outline;
- focused verification guidance.

SWARM should post or persist the child-specific plan with the newly created item and mark it
as preplanned. The child's normal Planning trigger should recognize that marker, validate
that the plan belongs to the current split operation, and avoid launching another agent run.
It should still perform the existing board/status behavior, including never auto-advancing a
split child to `ToDo`. A human edit that materially changes the child's scope, a missing or
invalid plan, or an explicit replan action should clear/bypass the marker and run Planning
normally.

This converts one repository analysis into plans for the entire split rather than paying for
one parent analysis plus one full analysis per child.

## 4. Move deterministic delivery mechanics out of Implementation

The Implementation agent currently implements and verifies the change, then commits, pushes,
constructs a PR body, opens the PR, and writes the PR URL to a hand-off file. The final steps
are mostly deterministic but consume turns and create late failure modes: a completed change
may need another run because `git push`, `gh pr create`, or the URL hand-off failed.

Let the agent finish after code and verification and write a structured change summary. SWARM
should then:

1. validate the working tree and required verification result;
2. create a conventional commit from a bounded template;
3. push the known task branch;
4. create the PR from the work item and change summary;
5. include the required closing reference and post the resulting URL.

The implementation persona's credentials and attribution rules must remain intact. Agent
fallback remains useful for genuinely judgment-dependent PR descriptions, but the normal path
should not require model participation in mechanical delivery.

This boundary also applies to later model delegation: deterministic operations must not be
delegated to a cheaper model merely because it costs less than the phase's primary model. Git
commit/push/PR creation, hand-off URL handling, code or Markdown formatters, prescribed command
execution, and collection of diff/CI metadata belong in SWARM or ordinary tooling. A lighter
model is appropriate only when the delegated operation still requires bounded semantic
judgment.

## 5. Give Review a preassembled review packet

Review currently spends part of its run fetching and reconstructing context: the PR body and
discussion, linked issue and proposed plan, complete diff, and CI state. SWARM already knows
most identifiers and can assemble that material before invoking the reviewer.

A review packet should contain:

- PR title, body, head SHA, and relevant discussion;
- the work item's acceptance criteria and agreed plan;
- Implementation's structured change summary;
- changed-file list and diffstat;
- the full diff, or a stable local path/command that reads the pinned diff;
- CI checks and verification results;
- applicable repository guidance.

The reviewer must still review every changed file and inspect surrounding checkout code when
verifying candidate findings. The packet removes context collection, not independent
judgment. It should be bounded and avoid duplicating the same content in both the prompt and
files available in the worktree.

## 6. Route models by phase risk and complexity

SWARM supports static per-phase CLI/model overrides, but every run within a phase currently
receives the same configured tier. Add deterministic model routing so inexpensive models
handle routine work and stronger models are reserved for tasks likely to benefit from them.

Useful signals include:

- task labels and explicit risk classification;
- changed-file count, diff size, and number of packages/components;
- paths associated with migrations, authentication, concurrency, security, or core lifecycle;
- whether an earlier attempt failed for a reasoning/quality cause;
- ambiguity and breadth identified by Planning.

A sensible starting policy is an inexpensive model for routine Planning and small low-risk
reviews, the normal model for focused Implementation, and stronger models for architectural,
security-sensitive, migration, concurrency, or unusually large work. Escalation should
follow a concrete failure or risk signal rather than making the highest tier the default.

Routing decisions, effective model, and escalation reason must be recorded on the run for
measurement and debugging.

### Bounded native subagent delegation inside an expensive phase

Pre-run routing chooses the primary model for an entire phase. It can be complemented by
native subagent delegation when a strong primary model (for example, Claude Opus) encounters
a substantial but tightly bounded semantic operation that does not require its reasoning
tier. Suitable examples include updating several documentation sections from already-decided
facts, applying a repetitive test pattern, or drafting a change summary from structured
evidence.

The primary agent can remain the coordinator and invoke a curated subagent definition pinned
to a lighter model such as Claude Haiku. The delegation request must specify:

- the exact task and facts already decided by the primary agent;
- allowed files and prohibited scope;
- the expected artifact or working-tree change;
- the verification command or completion evidence;
- whether the primary agent must inspect the result before hand-off.

This must not become permission for arbitrary nested agents. SWARM's current phase guard bans
all subagents to stop a pipeline persona from expanding into the complete workflow. Replace
that blanket rule only for an allowlist of project-owned, phase-scoped subagents with fixed
model tiers and restricted tools. The primary agent remains responsible for correctness and
must not delegate architecture, ambiguous requirements, migrations, security/concurrency
reasoning, broad refactors, or final high-risk judgment.

Native subagents are useful when the primary session must continue immediately with the
result. They are the first implementation option because they preserve the coordinator's
live context and avoid building another orchestration lifecycle up front.

Option B is a deliberate fallback: SWARM-orchestrated child runs. The primary agent writes a
validated delegation manifest, SWARM launches a lighter model/CLI in the same leased worktree,
and the primary session is resumed (or given a structured result) for final inspection. This
provides stronger file/tool enforcement, first-class usage records, independent retries, and
cross-CLI routing, at the cost of another run boundary, worktree coordination, and
resume/continuation complexity.

SWARM may replace Option A with Option B if native delegation proves unreliable or opaque—for
example, if model pinning is not honored consistently, child usage cannot be attributed,
tool/path restrictions cannot be enforced, failures cannot be retried independently, or the
parent frequently loses/duplicates delegated work. Compare both approaches using total quota
per successful task, correctness/rework rate, and operational failure rate. Do not migrate
merely because Option B is architecturally cleaner; its extra session overhead can outweigh
savings for small tasks.

Do not use subagents for deterministic operations covered by §4. In particular, delegating a
push to Haiku still spends model quota to execute a known command. The deterministic delivery
work must land first so the curated-subagent feature has a clean boundary and cannot absorb
commit, push, or PR responsibilities.

Delegation is not automatically cheaper. The primary model spends quota creating the request
and reviewing the result, while the subagent consumes its own input/output quota and may draw
from the same provider pool. Apply a minimum-size threshold and measure total quota per
successful task; a two-line README edit should normally stay with the primary agent or a
deterministic formatter, while coordinated edits across several documents may justify a
lighter subagent.

### Implemented boundary (unified Option B)

SWARM implements **Option B for every child-capable CLI** — one provider-neutral, SWARM-orchestrated
delegation path rather than a per-CLI native mechanism. The Codex capability spike (#184) established
that `codex exec` runs a single agent with no `--agent`/subagent mechanism, so native (Option A)
delegation is impossible there; rather than maintain a second, Claude-only native path beside it,
Claude was migrated onto the same Option B path. (The spike's findings are pinned by an executable
test, `tests/unit/delegation/codex-capability.spike.test.ts`, skipped when `codex` isn't installed.)

The flow: a phase's primary agent writes a validated delegation contract to
`.swarm-delegation-<id>.contract.json` and runs `swarm delegate <file>` (a deterministic SWARM
command, `src/cli/commands/delegate.ts` → `src/delegation/orchestrator.ts`), never a CLI subagent.
SWARM launches a lighter-model child in the same leased worktree:

- **Model pinning** — the child runs on the per-CLI `lightModels` tier (Claude→Haiku,
  Codex→`gpt-5.4-mini` by default), pinned via `--model`.
- **Tool/scope confinement** — Claude children are restricted to `Read`/`Edit` (no shell, so no
  git/commit/push/nested delegation); Codex children run under the `--sandbox workspace-write` policy
  rooted at the worktree with approvals disabled. A recursion guard (`SWARM_DELEGATION_DEPTH`) refuses
  a child that tries to delegate again.
- **Path enforcement** — provider-neutral and authoritative: SWARM diffs the worktree before/after
  the child and rejects (and reverts) any change outside the contract's `allowedPaths`. Contract
  paths are pre-validated to be documentation files outside protected areas (`.git`, `.claude`).
- **Usage attribution** — the child's reported usage (Claude JSON / Codex JSONL) is captured and
  recorded as a provider-neutral observation linked to the parent by run id.
- **Primary review** — the parent must inspect the returned diff and record an accepted/reworked
  disposition for every completed child, or the phase fails. Run history stores the child
  observations beside the parent phase.

It is disabled by default per project and phase, with the global `SWARM_DELEGATION_ENABLED` kill
switch. Antigravity has no usable tool/sandbox controls and stays unsupported (#185): a non-capable
CLI fails closed to the no-subagent prompt guard.

**Guarantees and limits.** Model pinning, usage attribution, and path scope are enforced for both
Claude and Codex. Tool restriction is strongest on Claude (an allowlist that removes shell entirely);
on Codex the OS sandbox confines writes to the worktree but the child can still run commands within
it, so path scope is enforced primarily by SWARM's post-hoc diff check (safe rejection) rather than a
per-file OS control. Delegation happens inline within the single primary run — SWARM does not (yet)
run the child across an independent run boundary with its own retry/resume lifecycle; that
between-runs variant remains a future option to promote only under the reliability/attribution/retry
criteria above, and the contract and observation shapes are provider-neutral so promoting it needs no
redefinition. Deterministic delivery (§4) stays outside delegation for every CLI.

### When delegation actually pays off (and when it does not)

Delegation is **not** a default cost win, and it is disabled out of the box for that reason. The
primary spends tokens writing the contract and reviewing the child's diff, and the child spends its
own — so the arithmetic only favours delegation when:

    cost(write contract @primary) + cost(review diff @primary) + cost(child @light)  <  cost(do it @primary)

The load-bearing term is the contract. Writing a *complete, precise* contract — every decided fact,
exact wording, exact placement — is most of the hard thinking; once it's written, the child is
essentially a typist. So delegation saves only on the **mechanical application**, never on the
**decision**. It is worthwhile only with a high *apply-to-decide ratio*: one small, already-made
decision applied across enough surface that the contract is cheap relative to the doing.

- **Pays off**: propagating one decided fact across several docs (e.g. a renamed config key updated
  consistently in README + ARCHITECTURE + skill docs — one decision, six near-identical edits);
  regenerating a table/list from a known source across sections; stamping a repetitive doc pattern
  across many entries.
- **Does not pay off**: a one- or two-spot edit (contract + review overhead exceeds the edit);
  anything where *what* to write is still undecided (that's the expensive part and is non-delegable);
  and — today — anything that isn't documentation, since `documentation-edit` is the only supported
  `delegationType`. The realistic niche is therefore **multi-file documentation propagation**, which
  is narrow.

Two better justifications than raw token cost: **context hygiene** (offloading a tedious multi-file
sweep keeps the primary's context on the actual problem) and **future parallelism** (async children
would give latency wins — not built yet, since delegation runs inline). The primary's prompt guard
(`delegationGuardLines`, `src/delegation/native.ts`) encodes this apply-to-decide test so an eligible
agent self-filters and skips delegations that would not pay off; the `minimumSemanticOperations`
threshold is the coarse backstop. Enable delegation only for a project with genuinely repetitive
multi-doc work, and confirm the win by measuring quota per successful task (§9) before trusting it —
if the numbers don't show a saving on the real workload, leaving it disabled is the correct outcome.

## 7. Add phase-specific effort and spending controls

Model choice alone does not bound how intensely a model reasons or how long it explores. The
installed Claude CLI exposes `--effort`, `--max-budget-usd`, tool allowlists, and skill
controls. The harness should represent provider-specific controls rather than assuming every
CLI has the same flags.

Initial Claude effort defaults could be:

- Planning: `medium`;
- Implementation: `high` for normal work, lower for trivial/documentation work;
- Review: `medium`, escalating for high-risk or large diffs.

`--max-budget-usd` is useful only for execution modes in which its accounting corresponds to
the quota being managed. Subscription/session limits may require other provider-specific
proxies or controls. Timeouts remain a safety net, but wall-clock time alone is a poor quota
budget because tool execution and model generation consume time differently.

Tool restrictions can also prevent phase expansion: read-only phases should not receive edit
capabilities, and pipeline runs should not load unrelated skills or workflows. Any restriction
must preserve the commands the phase genuinely needs.

## 8. Make verification bounded and project-defined

The instruction to run lint, type-check, and relevant tests makes each Implementation agent
rediscover commands and independently decide what “relevant” means. Define a project
verification profile with:

- fast checks required for every change;
- changed-path-to-test mappings;
- conditions that require the full suite;
- checks already guaranteed by CI;
- output-size limits and failure-summary behavior.

Planning should select commands from this profile, Implementation should run the selected
set, and Review should consume the recorded results rather than repeating broad verification
without a finding-specific reason. This keeps correctness gates explicit while preventing
unbounded or redundant test exploration.

## 9. Measure quota per successful task, not only per run

Per-run token usage is already recorded where a CLI reports it, but optimization requires an
aggregate view across all phases, retries, and continuations for one task. Add reporting for:

- input, output, cache-read, cache-creation, and reasoning tokens by phase and model;
- total reported usage per successfully completed or merged task;
- usage from failed, timed-out, deferred, and retried runs;
- Planning-to-Implementation discovery duplication;
- approval, comment, and requested-changes rates by review model and risk class;
- review usage per changed file and diff size;
- duration and outcome proxies for CLIs that do not expose token usage;
- cache-read ratio and the stability of reusable prompt prefixes.

Antigravity does not currently report structured usage, so comparisons involving it need to
be labelled as incomplete unless usage can be recovered reliably from another local session
record. Do not silently compare its duration to another CLI's tokens as if they were the same
measurement.

Every experiment should compare total quota per successful task and quality outcomes, not
merely show that one individual run became cheaper. For example, a cheap reviewer that causes
more response cycles may increase overall usage.

## Delivery order

Implement these changes incrementally and measure after each step:

1. Add task/phase/model usage aggregation and routing observability.
2. Produce structured Planning packets and consume them in Implementation.
3. Reuse the parent Planning run for all split-child plans.
4. Move commit, push, and PR creation into deterministic orchestration.
5. Add allowlisted native lighter-model subagents for bounded semantic work, building on the
   deterministic boundary from the preceding step.
6. Preassemble Review packets.
7. Add Planning skip policies and risk-based model/effort routing using the measured baseline.
8. Add project verification profiles and refine them from observed runs.

The checkpoint/resume work can proceed independently. Together, the two efforts address both
sides of quota waste: this document reduces the cost of a successful pipeline, while
`CHECKPOINTS.md` reduces work lost when a run is involuntarily interrupted.
