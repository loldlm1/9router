import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { controlledStream, deferred, sseEvent, socketError } from "../helpers/codex-stream-fixtures.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), release: vi.fn(), unavailable: vi.fn(), success: vi.fn(), pending: vi.fn(), refresh: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("@/sse/services/auth.js", () => ({
  acquireProviderCredentials: vi.fn(async () => ({ credentials: { connectionId: "synthetic", accessToken: "synthetic" }, lease: { release: mocks.release } })),
  markAccountUnavailable: mocks.unavailable, clearAccountError: mocks.success,
  extractApiKey: vi.fn(), isValidApiKey: vi.fn(async () => true),
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: vi.fn(async () => ({ provider: "codex", model: "gpt-6-astra" })), getComboModels: vi.fn(async () => null) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: mocks.refresh, updateProviderCredentials: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: mocks.pending, saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}) }));
vi.mock("open-sse/utils/requestLogger.js", () => ({ createRequestLogger: vi.fn(async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logError() {} })) }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/utils/logger.js", async (original) => ({ ...(await original()), debug() {}, info() {}, warn() {}, error() {}, errorLine() {}, line() {}, maskKey() {}, tagForSession() { return ""; } }));

import "../translator/registerAll.js";
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const created = sseEvent("response.created", { sequence_number: 0, response: { id: "resp_test", status: "in_progress" } });
const completed = sseEvent("response.completed", { sequence_number: 1, response: { id: "resp_test", status: "completed" } });
const sse = (body) => new Response(body, { headers: { "content-type": "text/event-stream" } });
function request(signal) {
  return new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-cli/1.0" }, body: JSON.stringify({ model: "cx/gpt-6-astra", input: "synthetic", stream: true, reasoning: { effort: "max" } }), signal });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockReset();
  mocks.refresh.mockImplementation(async (_provider, credentials) => credentials);
  vi.stubGlobal("fetch", () => { throw new Error("Unexpected network access"); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function expectReleased(req) {
  expect(mocks.release).toHaveBeenCalledTimes(1);
  expect(mocks.unavailable).not.toHaveBeenCalled();
  expect(mocks.pending.mock.calls.map((args) => args[3])).toEqual([true, false]);
  expect(getEventListeners(req.signal, "abort")).toHaveLength(0);
}

describe("real handleChat -> core -> Codex executor cancellation", () => {
  it("does not dispatch an already-aborted request", async () => {
    const abort = new AbortController();
    abort.abort();
    expect((await handleChat(request(abort.signal))).status).toBe(499);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
  });

  it.each(["headers", "preflight", "http_retry", "sse_retry"])("aborts during %s with one lease/pending release and no account penalty", async (phase) => {
    const started = deferred();
    const source = controlledStream();
    let upstreamSignal;
    mocks.fetch.mockImplementationOnce((_url, init) => {
      upstreamSignal = init.signal;
      started.resolve();
      if (phase === "headers") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      if (phase === "preflight") return sse(source.stream);
      if (phase === "sse_retry") return sse(sseEvent("error", { error: { code: "server_is_overloaded" } }));
      return new Response("busy", { status: 503 });
    });
    const abort = new AbortController();
    const req = request(abort.signal);
    const result = handleChat(req);
    result.catch(started.reject);
    await started.promise;
    // Let headers and preflight/retry ownership attach before injecting the abort.
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    expect((await result).status).toBe(499);
    if (phase === "preflight") await source.cancelled;
    expect(upstreamSignal.aborted).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expectReleased(req);
  });

  it("aborts an active stream even if the client stops reading", async () => {
    const source = controlledStream();
    source.write(created);
    mocks.fetch.mockResolvedValueOnce(sse(source.stream));
    const abort = new AbortController();
    const req = request(abort.signal);
    const response = await handleChat(req);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(created);
    abort.abort();
    await source.cancelled;
    expect((await reader.read()).done).toBe(true);
    expectReleased(req);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("keeps terminal-then-abort successful and releases once", async () => {
    mocks.fetch.mockResolvedValueOnce(sse(created + completed));
    const abort = new AbortController();
    const req = request(abort.signal);
    const response = await handleChat(req);
    expect(await response.text()).toContain(completed);
    abort.abort();
    expectReleased(req);
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });

  it("never retries partial tool arguments followed by reset", async () => {
    const source = controlledStream();
    source.write(created);
    mocks.fetch.mockResolvedValueOnce(sse(source.stream));
    const req = request();
    const response = await handleChat(req);
    const reader = response.body.getReader();
    await reader.read();
    const tool = sseEvent("response.function_call_arguments.delta", { sequence_number: 1, item_id: "call_test", delta: "{\"command\":" });
    source.write(tool);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(tool);
    source.error(socketError());
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: response.failed");
    expect((await reader.read()).done).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expectReleased(req);
  });
});
