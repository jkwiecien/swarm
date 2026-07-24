# ADR-003: Worker↔control-plane transport (WebSocket + HTTP), and split delivery

- **Status:** Accepted
- **Issue:** [#391](https://github.com/jkwiecien/swarm/issues/391)
- **Date:** 2026-07-24
- **Decision owners:** SWARM maintainers

> **ADR numbering note.** Issue #391 references
> `ADR-002-worker-transport-and-split-delivery.md §1`, but `ADR-002` on disk is
> `durable-dispatch-state-machine` (issue #284). The transport design had no ADR
> of its own — it lived only in the issue and PROJECT.md §2.2/§3 — so this record
> takes the next free number, **ADR-003**, and documents the decision the stale
> link pointed at.

## Context

PROJECT.md §3 specifies a future cloud/local split: a hosted control plane
coordinates work without seeing source, and independently operated local daemons
(`swarm-cli`) execute agent CLIs on their operators' machines. That spec pins the
wire protocol to **gRPC** — a single `ConnectAgent` bidirectional stream carrying
`AgentMessage`/`CloudMessage` frames (`HandshakeRequest`, `Heartbeat`,
`TaskAssignment`, `TaskExecutionResult`, `StreamLog`, …). Issue #300 ("gRPC
Bidirectional Control Plane & Local Daemon Client") tracked building that.

The MVP already has everything the *first* slice of that split needs, in-process:

- A worker identity + credential (`src/identity/worker-service.ts`, ADR-001).
- A fenced, TTL-based session lease with heartbeat/release
  (`src/identity/worker-session-service.ts`) — the exact liveness signal the
  eligibility gate (`src/identity/worker-eligibility.ts`, #130) consumes to drop a
  disconnected worker.
- A Cloudflare-tunnel-fronted **router** process that already holds
  `DATABASE_URL` (`docker-compose` `router` service, `docs/cloudflare-tunnel.md`).

What was missing was only the *transport*: a way for a **remote** daemon to reach
that credential→session→heartbeat service over the network instead of calling it
in-process. Standing up a full gRPC stack (protobuf toolchain, a new server
surface, HTTP/2 plumbing through the tunnel) for that one slice is disproportionate
to the MVP, and gRPC's streaming/codegen weight buys nothing the lease liveness
signal requires.

## Decision

### §1 — Transport: authenticated worker-session endpoint on the router (this phase)

Expose the worker transport as **two routes on the existing router Hono app**,
carried over **HTTP + WebSocket** rather than gRPC, reusing the in-process session
service verbatim:

- **`POST /worker/session`** — the handshake (request/response): validate
  `SWARM_WORKER_CREDENTIAL` against the worker roster
  (`resolveWorkerByCredential`), acquire the fenced `worker_sessions` lease
  (`acquireSession`), persist the daemon's declared CLIs
  (`refreshWorkerCapabilities`), and return the session (`sessionId`,
  `fencingToken`, `heartbeatTtlMs`).
- **`GET /worker/stream`** — a WebSocket (via `@hono/node-ws`) carrying periodic
  worker→cloud `heartbeat` frames that refresh the lease (`heartbeat`), and
  releasing the lease on disconnect (`releaseSession`). An ungraceful drop still
  expires via the heartbeat TTL — the existing mechanism.

HTTP carries the request/response handshake; the WebSocket carries the
long-lived, low-latency heartbeat stream. The raw credential travels only in the
handshake body and the stream's `Authorization: Bearer` header — never in a URL,
never logged, never reflected in a response body (the `worker-service.ts`
credential contract).

The wire messages get **Zod schemas** (`src/transport/protocol.ts`), the source of
truth per ai/CODING_STANDARDS.md. Their names track PROJECT.md §3's
`AgentMessage`/`CloudMessage` payloads (`HandshakeRequest`/`HandshakeResponse`/
`Heartbeat`) so a later gRPC engine can adopt the same vocabulary. A
`TRANSPORT_PROTOCOL_VERSION` is exchanged both ways so a mismatch is a clean
rejection rather than a silent misparse.

**No scheduler/eligibility/dispatch behavior changes.** The transport only keeps
the existing `worker_sessions` liveness signal fresh over the wire; the
eligibility gate already consumes that signal. The in-process host worker
(`src/worker/index.ts`) is untouched and keeps calling the session service
directly — the transport is a second front door to the same service, so the
single-user/same-machine path is unaffected.

### §2 — Split delivery (future work, not this phase)

The rest of PROJECT.md §3 — the control plane assigning jobs and the daemon
running them without direct DB/Redis access (`TaskAssignment` →
`TaskExecutionResult`/`StreamLog`) — is deferred to a later issue. When it lands,
its frames join the two Zod unions in `src/transport/protocol.ts`
(`WorkerStreamMessageSchema` / `ControlPlaneMessageSchema`), which this phase
leaves scoped to the handshake + heartbeat/ack/disconnect control frames. The
worker-side client (connect with only the credential, reconnect, local CLI
discovery) and the tunnel/env-var docs (`SWARM_CONTROL_PLANE_URL`) are Phase 2 of
issue #391.

> **Supersedes issue #300.** #300's gRPC bidirectional control plane is re-scoped:
> the MVP transport is WebSocket + HTTP on the router, not a gRPC stream. The gRPC
> `.proto` in PROJECT.md §3 remains the reference for message *shapes* and stays
> valid as a possible future engine, but is not what the MVP implements.

## Consequences

- A remote daemon establishes and keeps a live worker session using only its
  credential, with no new datastore or protocol stack — just the router's existing
  HTTP surface plus a WebSocket upgrade the Cloudflare tunnel passes through
  transparently.
- The eligibility gate's "stale/disconnected workers are not selectable" property
  holds over the network for free: liveness is the same lease, kept fresh by the
  heartbeat stream and expired by the TTL on disconnect.
- `@hono/node-ws` (plus `ws`) is added as a router dependency; the router entry
  point now injects the WebSocket handler onto the served HTTP server.
- The gRPC design in PROJECT.md §3 is retained as a reference for message shapes
  and a possible future transport, but is explicitly not the MVP's transport.
