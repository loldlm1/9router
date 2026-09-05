import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { deferred, sseEvent } from "../helpers/codex-stream-fixtures.js";
import { listenLoopback, listenConnectProxy, listenForwardingProxy } from "../helpers/codex-socket-fixtures.js";

const fixture = vi.hoisted(() => {
  const env = {
    CODEX_SSE_PEEK_TIMEOUT_MS: "30", CODEX_STREAM_STALL_TIMEOUT_MS: "1000", CODEX_STREAM_HEARTBEAT_MS: "15",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*", no_proxy: "",
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  return { previousEnv, proxyUrl: null, releases: 0, pending: 0, pendingCalls: [], success: 0 };
});
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("@/sse/services/auth.js", async () => {
  const { reserveAccountSlot } = await import("../../src/sse/services/accountAdmission.js");
  return {
    acquireProviderCredentials: vi.fn(async () => {
      const lease = reserveAccountSlot("codex", "synthetic", 5);
      if (!lease) throw new Error("Fixture concurrency exceeded");
      return {
        credentials: { connectionId: "synthetic", accessToken: "synthetic", providerSpecificData: { connectionProxyEnabled: !!fixture.proxyUrl, connectionProxyUrl: fixture.proxyUrl || "" } },
        lease: { release() { fixture.releases++; return lease.release(); } },
      };
    }),
    markAccountUnavailable: vi.fn(() => { throw new Error("Unexpected account fallback"); }),
    clearAccountError: vi.fn(async () => { fixture.success++; }),
    extractApiKey: vi.fn(), isValidApiKey: vi.fn(async () => true),
  };
});
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: vi.fn(async () => ({ provider: "codex", model: "gpt-6-astra" })), getComboModels: vi.fn(async () => null) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials), updateProviderCredentials: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn((_model, _provider, _connection, active) => { fixture.pending += active ? 1 : -1; fixture.pendingCalls.push(active); }),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}),
}));
vi.mock("open-sse/utils/requestLogger.js", () => ({ createRequestLogger: vi.fn(async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logError() {} })) }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/utils/logger.js", async (original) => ({ ...(await original()), debug() {}, info() {}, warn() {}, error() {}, errorLine() {}, line() {}, maskKey() {}, tagForSession() { return ""; } }));

import "../translator/registerAll.js";
const { POST } = await import("../../src/app/api/v1/responses/route.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { proxyAwareFetch, closeCodexDispatchers } = await import("../../open-sse/utils/proxyFetch.js");
const { getAdmissionSnapshot, __resetAccountAdmissionForTests } = await import("../../src/sse/services/accountAdmission.js");
const cases = new Map();
const activeUpstream = new Set();
const resources = [];
let origin, router, destinationSpy;
let nextId = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newCase(mode) {
  const id = `fixture-${++nextId}`;
  const value = { id, mode, fault: deferred(), closed: deferred(), attempts: 0 };
  cases.set(id, value);
  return value;
}

async function upstream(req, res) {
  const body = [];
  for await (const chunk of req) body.push(chunk);
  const payload = JSON.parse(Buffer.concat(body));
  const testCase = cases.get(payload.prompt_cache_key);
  if (!testCase) { res.writeHead(400); res.end(); return; }
  testCase.attempts++;
  testCase.payload = payload;
  activeUpstream.add(testCase.id);
  res.once("close", () => { activeUpstream.delete(testCase.id); testCase.closed.resolve(); });
  const socket = req.socket;
  const reset = () => { if (!socket.destroyed) socket.resetAndDestroy(); };
  if (testCase.mode === "headers_reset") { reset(); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  if (testCase.mode === "empty_reset") { await testCase.fault.promise; reset(); return; }
  if (testCase.mode === "idle") return;
  const created = sseEvent("response.created", { sequence_number: 0, response: { id: testCase.id, status: "in_progress" } });
  res.write(created);
  if (testCase.mode === "fin") { res.end(); return; }
  if (testCase.mode === "cancel") return;
  if (["creation_reset", "text_reset", "tool_reset"].includes(testCase.mode)) {
    if (testCase.mode === "text_reset") res.write(sseEvent("response.output_text.delta", { sequence_number: 1, delta: "partial" }));
    if (testCase.mode === "tool_reset") res.write(sseEvent("response.function_call_arguments.delta", { sequence_number: 1, item_id: "call_test", delta: "{\"command\":" }));
    await testCase.fault.promise;
    reset();
    return;
  }
  if (testCase.mode === "quiet") await sleep(400);
  if (res.destroyed) return;
  res.write(sseEvent("response.completed", { sequence_number: 2, response: { id: testCase.id, status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } }));
  if (testCase.mode === "terminal_reset") { await testCase.fault.promise; reset(); }
  else res.end();
}

async function serveRoute(req, res) {
  const abort = new AbortController();
  res.once("close", () => { if (!res.writableFinished) abort.abort(); });
  try {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    // Composes both known aliases with the real route; does not simulate Next rewrites.
    if (!["/v1/responses", "/api/v1/responses"].includes(req.url)) { res.writeHead(404); res.end(); return; }
    const request = new Request(`${router.origin}${req.url}`, { method: "POST", headers: req.headers, body: Buffer.concat(body), signal: abort.signal });
    const response = await POST(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.flushHeaders();
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch { res.destroy(); }
}

beforeAll(async () => {
  origin = await listenLoopback((req, res) => { void upstream(req, res).catch(() => res.destroy()); });
  router = await listenLoopback((req, res) => { void serveRoute(req, res); });
  destinationSpy = vi.spyOn(CodexExecutor.prototype, "buildUrl").mockImplementation(() => `${origin.origin}/responses`);
});
beforeEach(() => { fixture.proxyUrl = null; fixture.releases = 0; fixture.pending = 0; fixture.success = 0; fixture.pendingCalls = []; });
afterEach(async () => {
  for (const value of cases.values()) value.fault.resolve();
  for (const resource of resources.splice(0).reverse()) await resource.close();
  await vi.waitFor(() => {
    expect(activeUpstream.size).toBe(0);
    expect(fixture.pending).toBe(0);
    expect(Object.values(getAdmissionSnapshot().providers).reduce((sum, provider) => sum + provider.active + provider.queued, 0)).toBe(0);
  });
  cases.clear();
});
afterAll(async () => {
  destinationSpy.mockRestore();
  await router.close();
  await origin.close();
  await closeCodexDispatchers();
  __resetAccountAdmissionForTests();
  for (const [key, value] of Object.entries(fixture.previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fetchCase(testCase, target = router.origin, signal) {
  return proxyAwareFetch(`${target}${nextId % 2 ? "/v1/responses" : "/api/v1/responses"}`, {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "codex_cli_rs/synthetic" },
    body: JSON.stringify({ model: "cx/gpt-6-astra", instructions: "Synthetic transport test", input: "test", stream: true, prompt_cache_key: testCase.id, reasoning: { effort: "max" } }),
    signal: signal || AbortSignal.timeout(5000),
  });
}

async function exercise(mode) {
  const testCase = newCase(mode);
  const response = await fetchCase(testCase);
  if (mode === "headers_reset") {
    expect(response.status).toBe(502);
    await response.text();
    return { outcome: "failed", testCase };
  }
  expect(response.status).toBe(200);
  if (mode === "empty_reset") testCase.fault.resolve();
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    output += decoder.decode(read.value, { stream: true });
    const trigger = mode === "tool_reset" ? "response.function_call_arguments.delta" : mode === "text_reset" ? "response.output_text.delta" : mode === "terminal_reset" ? "event: response.completed" : "event: response.created";
    if (output.includes(trigger)) testCase.fault.resolve();
    if (mode === "cancel" && output.includes("event: response.created")) {
      await reader.cancel();
      await testCase.closed.promise;
      return { outcome: "cancelled", testCase };
    }
  }
  reader.releaseLock();
  expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  const expected = ["completed", "quiet", "terminal_reset"].includes(mode) ? "completed" : "failed";
  expect(output.match(/event: response.completed/g)?.length || 0).toBe(expected === "completed" ? 1 : 0);
  expect(output.match(/event: (?:response.failed|error)\n/g)?.length || 0).toBe(expected === "failed" ? 1 : 0);
  if (mode === "tool_reset") expect(output.match(/"item_id":"call_test"/g)).toHaveLength(1);
  expect(testCase.attempts).toBe(1);
  expect(testCase.payload).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "max" } });
  return { outcome: expected, testCase, output };
}

describe("real Responses socket transport", () => {
  it.each(["headers_reset", "empty_reset", "creation_reset", "text_reset", "tool_reset", "terminal_reset", "fin", "quiet", "idle", "cancel"])("handles %s without replay or abandoned work", async (mode) => {
    const { testCase } = await exercise(mode);
    await vi.waitFor(() => expect(fixture.releases).toBe(1));
    expect(testCase.attempts).toBe(1);
    expect(testCase.payload).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "max" } });
    expect(fixture.pendingCalls).toEqual([true, false]);
  });

  it("streams through a real outbound CONNECT proxy", async () => {
    const proxy = await listenConnectProxy([origin.origin]);
    resources.push(proxy);
    fixture.proxyUrl = proxy.origin;
    expect((await exercise("quiet")).outcome).toBe("completed");
    expect(proxy.tunnels).toBe(1);
  });

  it("survives a downstream read-idle proxy while heartbeats arrive", async () => {
    const ingress = await listenForwardingProxy(router.origin, { idleMs: 200 });
    resources.push(ingress);
    const response = await fetchCase(newCase("quiet"), ingress.origin);
    const output = await response.text();
    expect(output).toContain(": keepalive\n\n");
    expect(output).toContain("event: response.completed");
  });

  it.each(["buffering", "absolute"])("exposes %s ingress limits despite healthy router heartbeats", async (mode) => {
    const ingress = await listenForwardingProxy(router.origin, mode === "buffering" ? { buffering: true } : { durationMs: 200 });
    resources.push(ingress);
    const pending = fetchCase(newCase("quiet"), ingress.origin, AbortSignal.timeout(mode === "buffering" ? 200 : 5000)).then((response) => response.text());
    await expect(pending).rejects.toThrow();
  });

  it("settles 100 mixed requests at concurrency five with exact totals and empty admission", async () => {
    const modes = ["completed", "fin", "creation_reset", "tool_reset", "cancel"];
    const totals = { completed: 0, failed: 0, cancelled: 0 };
    let issued = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (issued < 100) {
        const index = issued++;
        const result = await exercise(modes[index % modes.length]);
        totals[result.outcome]++;
        await result.testCase.closed.promise;
      }
    }));
    await vi.waitFor(() => expect(fixture.releases).toBe(100));
    expect(issued).toBe(100);
    expect(totals).toEqual({ completed: 20, failed: 60, cancelled: 20 });
    expect([...cases.values()].reduce((sum, value) => sum + value.attempts, 0)).toBe(100);
    expect(fixture.pendingCalls.filter(Boolean)).toHaveLength(100);
    expect(fixture.pendingCalls.filter((value) => !value)).toHaveLength(100);
    expect(fixture.success).toBe(20);
  }, 15000);
});
