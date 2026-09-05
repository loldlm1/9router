import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { controlledStream, deferred, socketError, sseEvent, readText } from "../helpers/codex-stream-fixtures.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", () => { throw new Error("Network denied"); }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const sse = (body) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const created = sseEvent("response.created", { response: { id: "resp_test", status: "in_progress" } });
const overloaded = sseEvent("error", { error: { code: "server_is_overloaded", message: "Busy" } });
const args = () => ({ model: "gpt-6-astra", body: { input: "test", reasoning: { effort: "max" }, tools: [{ type: "web_search" }] }, stream: true, credentials: { accessToken: "synthetic" } });

describe("bounded Codex preflight", () => {
  it("hands off an empty body at the deadline, retaining exactly one pending read", async () => {
    vi.useFakeTimers();
    const source = controlledStream();
    const signal = new AbortController().signal;
    const response = sse(source.stream);
    const readerSpy = vi.spyOn(response.body, "getReader");
    let settled = false;
    const pending = new CodexExecutor()._peekSseTransientError(response, { signal, timeoutMs: 50 }).then((v) => { settled = true; return v; });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const peek = await pending;
    expect(readerSpy).toHaveBeenCalledTimes(1);
    const read = readText(peek.replacementBody);
    source.write(created);
    source.close();
    expect(await read).toBe(created);
    expect(source.stream.locked).toBe(false);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["response.created", "response.in_progress", "response.reasoning_summary_text.delta", "response.custom_tool_call_input.delta"])("hands off immediately on %s", async (type) => {
    const source = controlledStream();
    const first = sseEvent(type, { delta: "server_is_overloaded", response: { id: "resp_test" } });
    source.write(first);
    const peek = await new CodexExecutor()._peekSseTransientError(sse(source.stream));
    expect(peek.matched).toBeNull();
    source.close();
    expect(await readText(peek.replacementBody)).toBe(first);
  });

  it("counts bytes and preserves a chunk larger than the cap without another read", async () => {
    const source = controlledStream();
    const prefix = ": " + "\u00e9".repeat(30);
    source.write(prefix);
    const peek = await new CodexExecutor()._peekSseTransientError(sse(source.stream), { maxBytes: 32 });
    source.write("\n\n" + created);
    source.close();
    expect(await readText(peek.replacementBody)).toBe(prefix + "\n\n" + created);
  });

  it("classifies a fragmented complete error and disposes its reader", async () => {
    const source = controlledStream();
    source.write(overloaded.slice(0, 12));
    const pending = new CodexExecutor()._peekSseTransientError(sse(source.stream));
    source.write(overloaded.slice(12));
    expect(await pending).toMatchObject({ matched: "server_is_overloaded", replacementBody: null });
    await source.cancelled;
    expect(source.stream.locked).toBe(false);
  });

  it("does not classify capacity after a normal event, even in the same chunk", async () => {
    const body = created + overloaded;
    const peek = await new CodexExecutor()._peekSseTransientError(sse(body));
    expect(peek.matched).toBeNull();
    expect(await readText(peek.replacementBody)).toBe(body);
  });

  it("propagates a read exception and its nested cause", async () => {
    const source = controlledStream();
    const error = socketError();
    const pending = new CodexExecutor()._peekSseTransientError(sse(source.stream));
    source.error(error);
    await expect(pending).rejects.toBe(error);
    expect(source.stream.locked).toBe(false);
  });

  it("cancels a pending preflight read immediately and removes timers/listeners", async () => {
    vi.useFakeTimers();
    const source = controlledStream();
    const abort = new AbortController();
    const pending = new CodexExecutor()._peekSseTransientError(sse(source.stream), { signal: abort.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await assertion;
    await source.cancelled;
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounded pre-commit retries", () => {
  it("shares the HTTP and SSE retry budget, preserves fields, and disposes rejected bodies", async () => {
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { 502: { attempts: 3, delayMs: 0 }, 503: { attempts: 3, delayMs: 0 } } };
    const cancelled = vi.fn();
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { status: 503 }))
      .mockResolvedValueOnce(sse(overloaded))
      .mockResolvedValueOnce(new Response("rejected", { status: 502 }))
      .mockResolvedValueOnce(sse(overloaded));
    const result = await executor.execute(args());
    expect(result.response.status).toBe(503);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    expect(cancelled).toHaveBeenCalledTimes(1);
    const bodies = proxyAwareFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect(bodies[0]).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "max" }, tools: [{ type: "web_search" }] });
  });

  it("does not replay an ambiguous accepted request or a failed connection", async () => {
    const source = controlledStream();
    proxyAwareFetch.mockResolvedValueOnce(sse(source.stream));
    const dispatch = new CodexExecutor().execute(args());
    await vi.waitFor(() => expect(proxyAwareFetch).toHaveBeenCalledTimes(1));
    source.error(socketError());
    await expect(dispatch).rejects.toMatchObject({ fallbackScope: "request", cause: { code: "UND_ERR_SOCKET" } });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    proxyAwareFetch.mockRejectedValueOnce(socketError());
    await expect(new CodexExecutor().execute(args())).rejects.toMatchObject({ fallbackScope: "request" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("stops a retry wait when the client aborts", async () => {
    const rejected = deferred();
    proxyAwareFetch.mockImplementationOnce(async () => { rejected.resolve(); return new Response("busy", { status: 503 }); });
    const abort = new AbortController();
    const pending = new CodexExecutor().execute({ ...args(), signal: abort.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await rejected.promise;
    abort.abort();
    await assertion;
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
