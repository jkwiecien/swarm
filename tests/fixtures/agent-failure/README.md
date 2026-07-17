# Agent-failure classifier fixtures

Captured terminal-output tails used by `tests/unit/harness/agent-failure.test.ts`
to pin `classifyAgentFailure` (`src/harness/agent-failure.ts`) against the real
shape of each CLI's transient provider-capacity banner. Each fixture is scoped to
one CLI (the classifier gates capacity matching by `result.cli`) and carries a
documented source, so a signature is only trusted after its terminal shape is
confirmed — never inferred from another CLI or a bare status code.

| Fixture | CLI | Signature | Source |
| --- | --- | --- | --- |
| `codex-capacity-transcript.txt` | codex | `Selected model is at capacity` | Codex CLI provider error (observed); reported separately from account quota. |
| `claude-529-overloaded-transcript.txt` | claude | `API Error: 529 Overloaded` | Observed live on run `cdbba4f7-feee-4687-a226-1705ee862a89` (issue #229); Anthropic documents 529 as a temporary overload — <https://platform.claude.com/docs/en/api/errors>. |
| `claude-529-repeated-transcript.txt` | claude | repeated `529` + `overloaded_error` | Claude Code's retry path prints one 529 line per attempt before giving up — <https://code.claude.com/docs/en/errors>; the `overloaded_error` type is the JSON error body Anthropic returns with a 529. |

Each Claude fixture opens with borrowed rate-limit / HTTP-`429` prose and code
mentions ahead of the terminal banner: the classifier must ignore those (they sit
outside the terminal-tail window, or are the wrong CLI's signal) and key only on
the final provider banner. That is the false-positive resistance the tests assert.

Antigravity/Gemini transient signals (`429 RESOURCE_EXHAUSTED`, `503 UNAVAILABLE`
— <https://ai.google.dev/gemini-api/docs/troubleshooting>) and additional
Codex/OpenAI retryable statuses (`408`/`409`/`429`/`5xx` in the OpenAI Node SDK)
are deliberately **not** added here: no `agy`/`codex` terminal-output fixture
demonstrating their emitted shape has been captured yet. Add a fixture + row above
before extending the classifier to them (issue #229 provider-signature audit).
