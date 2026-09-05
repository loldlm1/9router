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
| 5 | 24 integration/admission/lifecycle tests passed; production build and HTTP server regression passed; broad-suite failures match the baseline (details below) | `72a23200` |

Sprint 1 commit: `8dc5f120`. Sprint 2 commit: `4f1419b1`; rollback parent
`8dc5f120`.
Sprint 3 commit: `30d00735`; rollback parent `4f1419b1`.
Sprint 4 commit: `72a23200`; rollback parent `30d00735`. Sprint 5 base is
`72a23200`. Sprint 5 is the commit introducing
`tests/integration/codex-stream-transport.test.js`, with subject
`test(codex): verify long-stream recovery and document VPS rollout`.
Resolve its SHA with `git log --diff-filter=A --format=%H -- tests/integration/codex-stream-transport.test.js`.
The local sprint batch and the subsequent VPS validation have separate gates:
the user owns the VPS pull, rebuild, and startup; live checks remain pending.

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

## Sprint 5 local validation

All tests used synthetic credentials and isolated data at
`/tmp/9router-stream-qa-xzP2lm/data`, with `RUN_REAL=0`. No local incident logs,
personal Codex sessions, or real provider accounts were used.

The real Responses route, chat core, Codex executor, and admission slots were
exercised over loopback sockets. The fixture checks resets before headers,
before events, after creation, mid-text, mid-tool arguments, and after terminal;
FIN without terminal; quiet streams; inactivity; client cancellation; outbound
CONNECT proxy; and ingress buffering/read-idle/hard-cutoff behavior. Resets after
commitment wait for downstream headers or the relevant event before injection.
All individual fault cases assert one upstream attempt and preserved Astra/max
settings. The test fixture uses 30 ms preflight, 1000 ms upstream read idle, and
15 ms heartbeats; it does not simulate twelve minutes of real elapsed time.

The mixed run issued 100 requests at concurrency five: exactly 20 completed,
60 failed, and 20 cancelled, with 100 upstream attempts, 100 lease releases,
100 pending acquisitions/releases, 20 success callbacks, and no active/queued
admission slots or active upstream responses afterward. Existing admission
shadow-load tests also passed. These are router cleanup and transport results;
they do not demonstrate actual Codex task continuation or tool execution.

Commands and results (2026-09-05):

```bash
DATA_DIR=/tmp/9router-stream-qa-xzP2lm/data RUN_REAL=0 \
  rtk test npm --prefix tests test -- --config vitest.config.js \
  integration/codex-stream-transport.test.js \
  unit/codex-admission-shadow-load.test.js unit/response-lifecycle.test.js
# PASS: 24 tests across 3 suites, including final no-replay assertions.

DATA_DIR=/tmp/9router-stream-qa-xzP2lm/data RUN_REAL=0 \
  NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR=.next-cli-build/stream-reliability \
  rtk test npm run build
# PASS: production build and standalone asset-copy step.

node --test tests/unit/custom-server-h2c.test.cjs
# PASS: 1 test.

rtk test ./node_modules/.bin/eslint \
  tests/integration/codex-stream-transport.test.js tests/helpers/codex-socket-fixtures.js
# PASS: both changed JavaScript files.

git diff --check
# PASS: whitespace check.

DATA_DIR=/tmp/9router-stream-qa-xzP2lm/data RUN_REAL=0 \
  rtk test npm --prefix tests test -- --config vitest.config.js \
  --exclude 'translator/real/**'
# FAIL: existing baseline failures; see comparison below.
```

The broad run reported 227 passing suites, 21 failing suites, and four skipped;
2387 passing tests, 85 failures, 17 expected failures, and 26 skipped. Three
integration-harness failures were corrected, and the final 24-test command above
passed. All remaining failures reproduce at `9f57d45c`: 82 failing tests plus
four suite-loading errors across 20 existing suites. Comparing exact failure
labels found no new or removed failures in those existing suites. Seven
additional Responses/translator regression suites passed; the accompanying two
Kiro failures also reproduced at baseline. The full suite is not green. Local
acceptance is based on passing scoped checks and this baseline comparison, not
on silently excluding or fixing unrelated defects.

The baseline was extracted with `git archive 9f57d45c` into
`/tmp/9router-stream-baseline-89njrr6w` with its own synthetic data. Private test
artifacts, which are temporary and are not shipped to the VPS:

- Candidate broad log: `/home/loldlm/.local/share/rtk/tee/1788623467_test.log`.
- Baseline broad log: `/home/loldlm/.local/share/rtk/tee/1788623882_test.log`.
- Exact-label comparison: `/tmp/9router-stream-qa-xzP2lm/regression-comparison.json`.
- Additional regression log: `/home/loldlm/.local/share/rtk/tee/1788623876_test.log`.
- Built-app smoke log: `/tmp/9router-stream-qa-xzP2lm/built-app-smoke.log`.

The built app started with isolated data and returned `{"ok":true}` from
`/api/health`. Both `/v1/responses` and `/api/v1/responses` returned the same
`401 Missing API key`. The smoke driver exited unsuccessfully because it
expected a missing-provider response instead of authentication rejection. This
is partial startup/authentication-routing evidence, not an authenticated stream
check. Its process was stopped afterward. Optional `better-sqlite3` binding
warnings occurred on this Node version; the existing fallback allowed the build
and health check to succeed. Native DB-dependent baseline tests remain failing.

Candidate identifiers:

- Runtime: Node `24.6.0`, bundled Undici `7.13.0`, npm Undici `7.29.0`, Next.js `16.2.12`.
- Product source: `72a23200300145fb17736530d6915c44983930b6`; Sprint 5 changes only tests/docs.
- Source tree at build: `038b5f400fd3a34305b3ba4556742a40bfe2e832` (plus uncommitted tests/docs).
- Lockfile SHA-256: `3a2b7eaf85272b00c200e7842a008d12be5f2491c4f8ad3188f2dd8c18ddd38b`.
- Local build: `.next-cli-build/stream-reliability`, build ID `t5Eej8I19aHTA32HBrE6Q`.
- Standalone output: `.next-cli-build/stream-reliability/standalone/`.

The local build is validation output, not a published release artifact. The VPS
will build its own artifact after pulling; record that artifact's identity and
repeat runtime/stream checks there. A matching source SHA does not prove the
same runtime, native bindings, ingress behavior, or Codex recovery.

## Manual VPS handoff

The user will pull and start 9router manually. This implementation batch did not
connect to, deploy to, start, restart, or change the VPS. Keep the exact current
working release/build and its provider/environment/ingress settings available
for rollback before replacing the serving process. No data migration is needed.

In the intended VPS checkout on `master`, after the sprint commits are available
on `loldlm1/9router`:

```bash
git pull --ff-only origin master
git log -5 --oneline
```

The last five commits should be the ordered sprint commits in this execution
record. Use the existing deployment method and supervisor to rebuild and start
that revision. If the existing method is the repository's standalone runner,
`npm run vps -- --rebuild` rebuilds and starts it; use it only in a separate
release directory or after draining/stopping the old serving process. Pulling
source alone does not replace a previously built/running artifact. Preserve the
selected Astra model and reasoning settings.

After manual startup, record the deployed revision, build/runtime and affected
Codex version, origin/public routes, ingress limits, and outbound proxy mode
using the worksheet. Then complete plan Tasks 5.2 and 5.3: both Responses route
aliases, a timed stream of at least 12 minutes through origin/public ingress,
actual parser behavior with heartbeat comments, cancellation followed by another
request, controlled reconnect/next-step recovery, and the 30-minute live-task
observation. These checks are pending; health and local socket tests cannot
establish that the reported VPS interruption is resolved.

For a stream-integrity, retry, or lease-cleanup regression, drain the candidate
and restore the recorded previous release using the same supervisor, together
with its previous timeout/heartbeat/provider/ingress settings. Confirm health
and a completed Responses stream. Exact service commands belong in the VPS
worksheet once the service is identified. For source rollback, revert dependent
sprint commits in reverse order; the complete pre-batch baseline is `9f57d45c`.
Do not reset the checkout, delete data volumes, or replay tools/conversation
history. Heartbeats can be disabled for new requests using
`CODEX_STREAM_HEARTBEAT_MS=0`, but that alone does not roll back the batch.
