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
| 3 | 71 tests passed across 10 startup, cancellation, capacity/fallback, admission, lifecycle, image, and concurrency suites; whitespace check passed | `4f1419b1` |
| 4 | 84 tests passed across 8 timeout, heartbeat, framing, startup/cancellation, diagnostic, and base-retry suites; native loopback body/header timeout checks passed | `30d00735` |

Sprint 1 commit: `8dc5f120`. Sprint 2 commit: `4f1419b1`; rollback parent
`8dc5f120`.
Sprint 3 commit: `30d00735`; rollback parent `4f1419b1`.

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

## Startup and retry ownership

`CODEX_SSE_PEEK_TIMEOUT_MS` defaults to 1000 ms (valid range 1..10000).
`CODEX_SSE_PEEK_BYTES` defaults to 262144 bytes (1024..1048576). Invalid values
use defaults. Preflight ends on the first complete normal event, deadline, or
byte cap. Comments alone can wait until the deadline. One existing reader and
any pending read transfer to the live stream; already-read bytes are preserved.
The prefix holds at most the cap plus the final incoming chunk's excess bytes.
The ordinary stream parser separately bounds individual event size.

Only parsed error envelopes can trigger overload/capacity handling before that
handoff. Errors arriving after a normal event belong to the committed stream.
Content containing an overload word is never retried. Codex network failures
and accepted-body read failures are request-scoped because a failed POST may
already have started work upstream. Codex owns recovery; the router does not
replay partial output or tool arguments.

With the current defaults and one Codex endpoint, HTTP and preflight overload
retries share **three retries: at most four dispatches per executor call**.
503/502 allow three retries, 504 allows two, and 429 rotates accounts without
same-account retries. A definite SSE model-capacity rejection also rotates
accounts. The existing core permits one credential-refresh replay (at most
eight dispatches per selected account across its two executor calls). Each
eligible account is selected at most once by the account fallback loop: for N
eligible accounts the conservative bound is 8N. Client request/stream retries
are separate; these bounds describe one single-model router request. There is
no post-commit router retry. Explicit model/reasoning and entitlement validation
remains request-scoped. A larger configured retry count changes these bounds.

The inbound abort now reaches the core controller, upstream fetch, bounded
preflight, HTTP/SSE/refresh retry waits, and stream pipes. Lease and pending
release are idempotent, including a client that stops consuming the body.
Refresh/preprocessing boundaries recheck cancellation before dispatch. Image
prefetch keeps its original finite timeout alongside the request signal.
Shared credential refresh already in progress may finish, but cannot dispatch
another model request for the cancelled client.

Sprint 3 validation uses the plan's six suites plus `response-lifecycle`,
`responses-abort-terminal`, `image-fetch-hardening`, and `prefetch-images`.
All use `RUN_REAL=0` and isolated test data. The new cancellation tests call
the real chat entry, core, executor, and stream handler, with synthetic fetch,
credentials, and persistence. No live provider is contacted. Revert this sprint
as a unit to `4f1419b1` after reverting later dependencies and draining streams.
Shorter preflight intentionally exposes later provider failures to client
recovery; the deployed client still needs the Sprint 5 check.

## Timeout and liveness policy

| Boundary | Default and control | Meaning |
| --- | --- | --- |
| Codex preflight | 1000 ms, `CODEX_SSE_PEEK_TIMEOUT_MS` | Maximum startup peek, not model time to first token |
| TCP/TLS connection | 10000 ms, `CODEX_FETCH_CONNECT_TIMEOUT_MS` (1..120000) | Connection setup to origin/proxy |
| Response headers | 60000 ms, `FETCH_CONNECT_TIMEOUT_MS` | Existing outer fetch deadline and Codex dispatcher header budget |
| Router upstream reads | 360000 ms, `CODEX_STREAM_STALL_TIMEOUT_MS` (1..86400000) | Falls back to `STREAM_STALL_TIMEOUT_MS`, capped at 24 hours |
| HTTP body inactivity | 390000 ms, `CODEX_FETCH_BODY_TIMEOUT_MS` | Always at least router idle + 30000 ms cleanup margin; maximum configured value 86430000 |
| Downstream comments | 15000 ms, `CODEX_STREAM_HEARTBEAT_MS` (0..60000) | `0` disables comments; never resets the upstream watchdog |
| Codex SSE idle | Current documented default 300000 ms | Selected provider's `stream_idle_timeout_ms`; deployed value/parser unknown |
| Ingress idle/hard duration | Unknown until VPS inspection | Distinct hop; comments cannot extend a hard duration cap |

The `CODEX_STREAM` safe policy fields show resolved defaults/overrides. New Codex
environment values require finite integers in the documented range; invalid
values use defaults. Header timing does not impose a total response duration.
Node server `requestTimeout` and `keepAliveTimeout` are not substitutes for an
active SSE response timeout.

Codex Responses use reused scoped Undici dispatchers for direct, HTTP(S) proxy,
and relay requests. The timeout values are set on each dispatch as well as the
pool. A configured proxy failure does not fall through to a direct retry.
Relays retain target/path headers and use the configured egress for the relay
hop. Other providers' fetch policy is unchanged. TLS verification remains on.
The scoped cache retains at most 20 pools; evicted pools close after existing
requests drain instead of abandoning their sockets. Retiring active pools can
temporarily exceed the cache size. Drain before replacing a serving process.

For Responses passthrough, `: keepalive` comments appear only between complete
SSE frames. At most one comment can queue while a client stops reading. Comments
do not add content, usage, first-token timing, or upstream progress. The response
adds `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform` while
preserving CORS. Application read inactivity can include downstream backpressure;
it must not be presented as proof that no network packet arrived upstream.

Calibration requires the affected Codex build: verify whether comments count
as idle activity. If they do not, choose a finite provider idle budget greater
than the permitted semantic-event gap and router failure-delivery budget. For
the defaults, 450000 ms is a candidate to measure, not an applied configuration.
Keep Astra and its reasoning selection unchanged. Do not raise retry counts to
hide broken streams. Identify the actual ingress before applying its equivalent
buffering/read-timeout configuration; no nginx or CDN is assumed here.

Sprint 4 tested Node `24.6.0`, bundled Undici `7.13.0`, npm Undici `7.29.0`,
and Next.js `16.2.12`. Real native fetch produced `UND_ERR_BODY_TIMEOUT` in one
controlled run each through direct, connection proxy, environment proxy, and
relay paths, and `UND_ERR_HEADERS_TIMEOUT` before headers. This is loopback
evidence, not evidence of the deployed runtime or TLS ingress behavior.
No tests changed client or VPS settings. Roll back to `30d00735` as a coherent
sprint, restore prior settings, and recycle the process after drain. Heartbeat
can also be disabled for new requests with `CODEX_STREAM_HEARTBEAT_MS=0`.

Official references rechecked 2026-09-05:
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Undici Client](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md),
[Dispatcher close](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md),
[ProxyAgent](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md).
Installed-runtime socket tests determine the behavior of the candidate; current
upstream documentation does not establish the VPS version or effective settings.
