# Codex stream reliability

`CODEX_ROUTE status=200` records HTTP acceptance. `CODEX_STREAM` records a
request UUID, upstream attempt ordinal, phase, elapsed timing, counters, and an
allowlisted error classification. HTTP acceptance is not Responses completion.

The diagnostics contain no request bodies, response text, credentials, account
emails, proxy URLs, raw error messages, or stacks. Upstream read timing measures
bytes consumed by the application; it is not a packet capture. A downstream
write means enqueueing to the response stream, not acknowledgement by Codex.
`first_upstream_event_ms` measures event parsing, not the first generated token.

## VPS worksheet

Collect this on the actual deployment, without dumping environment or auth files:

- Deployed source revision or immutable image digest and release/supervisor name.
- Node version, bundled Undici version, resolved Next.js and npm Undici versions.
- Affected Codex version and the selected provider's effective retry/idle settings.
- Public ingress and direct origin route; ingress buffering, read-idle and hard
  duration limits; outbound direct/proxy/relay mode with credentials omitted.
- Correlated `CODEX_STREAM` request/attempt records, HTTP status, terminal kind,
  nested error code, and last application read/write timings.

Compare a controlled stream through the direct origin and public ingress. A
healthy origin and failing public route localizes the boundary without implying
that every socket close is an ingress timeout. Keep test data and credentials
separate from the serving release. `/api/health` must return `{"ok":true}`, but
a health check does not validate streaming.

## Execution record

| Sprint | Validation | Rollback base |
| --- | --- | --- |
| 1 | 38 tests passed across diagnostics, capacity, fallback, and native reasoning; diagnostics rerun passed after always-visible failure logging | `9f57d45c` |
| 2 | 63 tests passed across terminal/framing, abort/outcome, diagnostics, lifecycle, native reasoning, and non-streaming suites; whitespace check passed | `8dc5f120` |

Sprint 1 commit: `8dc5f120`. Sprint 2 commit uses
`fix(codex): unify Responses terminal handling and outcomes`.

Responses passthrough now uses the same framed stream path for Codex, Droid,
and other user agents. Only a complete, valid terminal settles successfully.
Failed/incomplete events retain upstream reasons and usage; premature EOF,
malformed frames, or resets yield one failure. Failure reuses the known response
ID and next sequence number, or uses a generic `error` before an ID exists.
Completed output cannot be followed by a generated failure. Terminal callbacks,
pending release, cancellation cleanup, and ordered detail writes settle once.
Each pending event is bounded by `RESPONSES_MAX_EVENT_BYTES` (16 MiB default).

The Sprint 2 command is the plan's six-suite command, with `RUN_REAL=0` and an
isolated temporary `DATA_DIR`. These tests use synthetic data and mocked
persistence. The deployed Codex parser and VPS path still require validation;
truthful failure reporting cannot prevent an upstream socket reset. Roll back
dependent sprints first, then revert Sprint 2 as a unit to `8dc5f120`.

Sprint 1 also plumbs diagnostics through `BaseExecutor`, the chat entry point,
and stream factories so account fallback shares a request ID and each fetch gets
an attempt ordinal. This is instrumentation only; startup, terminal, and timeout
corrections are implemented in the subsequent ordered sprints.

The implementation plan is `codex-long-task-stream-reliability-plan.md`.
Operational verification on the VPS remains pending. No incident logs from the
local workstation are used as evidence for the VPS-only report.
