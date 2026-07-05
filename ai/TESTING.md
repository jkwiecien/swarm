# Testing & git hooks

Same tooling as Cascade — copy its config rather than picking a different stack.

## Test runner

**Vitest**, not Jest. Split into unit and integration projects, same as Cascade:

- **Unit tests** (`tests/unit/**/*.test.ts`) — mock every external call (GitHub API, GitHub Projects GraphQL, filesystem/git worktree operations, LLM CLI subprocess calls). No real network, no real Postgres/Redis. Use `vi.mock()` at the top of the file, before imports, wrapping every method of the client being mocked — see Cascade's `tests/unit/pm/linear/adapter.test.ts` for the exact shape to copy.
- **Integration tests** (`tests/integration/**/*.test.ts`) — run against a real, ephemeral Postgres (`npm run test:db:up` starts it from `docker-compose.test.yml`, same pattern as Cascade; a real Redis joins that compose file when the first Redis-dependent test lands). Run serially, not in parallel, to avoid state collisions. Suites gate on `describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)` — set by `tests/integration/setup.ts` — so a machine without the test database skips rather than fails.

## Test data

Use factory functions (`createMockProject()`, `createMockGitHubProjectsItem()`, etc.) that return sensible defaults and accept `Partial<T>` overrides, mirroring Cascade's `tests/helpers/factories.ts`. Don't hand-construct the same fixture object inline in every test file.

## Provider conformance

Once there's more than one PM or SCM provider (there won't be for a while — MVP has exactly one of each), add a conformance test suite mirroring Cascade's `tests/unit/integrations/pm-conformance.test.ts`: assert every registered provider's manifest has the required shape (unique id, webhook route convention, required methods present) so a new provider can't silently skip part of the contract. Not needed before then — don't build it speculatively for a single provider.

## Git hooks (Lefthook)

`lefthook.yml`, installed via the npm `prepare` script:

- **pre-commit** (parallel): Biome lint+format on staged files (auto-fix + re-stage), `tsc --noEmit` typecheck.
- **pre-push**: run the unit test suite (changed-file-scoped if the project grows large enough to need it, like Cascade's `test:fast`; just run everything while the suite is small).
- **commit-msg**: conventional-commit format enforced via commitlint.

## What "done" means for a change

Same bar as `ai/RULES.md` §6 (Workflow expectations) already states: don't claim a change is finished without actually running lint, typecheck, and the relevant tests. If a hook or command couldn't be run in your environment, say so explicitly rather than asserting it passed.
