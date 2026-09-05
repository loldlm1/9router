import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { createResponsesStreamLifecycle } from "../../open-sse/utils/responsesStreamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { controlledStream, sseEvent } from "../helpers/codex-stream-fixtures.js";

vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}) }));
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", () => { throw new Error("Network denied"); }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const completed = sseEvent("response.completed", { response: { id: "resp_test", status: "completed" } });
function harness(heartbeatMs = 10) {
  const source = controlledStream();
  const lifecycle = createResponsesStreamLifecycle();
  const complete = vi.fn();
  const onError = vi.fn();
  const controller = createStreamController({ onError, log: { errorLine() {} } });
  const transform = createSSEStream({ targetFormat: FORMATS.OPENAI_RESPONSES, sourceFormat: FORMATS.OPENAI_RESPONSES, responsesLifecycle: lifecycle, onStreamComplete: complete });
  const output = pipeWithDisconnect(new Response(source.stream), transform, controller, () => lifecycle.failureBytes(), 55, lifecycle, heartbeatMs);
  return { source, controller, complete, onError, reader: output.getReader() };
}
const text = (result) => new TextDecoder().decode(result.value);

describe("Codex framed heartbeat delivery", () => {
  it("keeps transport alive without masking the independent upstream stall deadline", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      const read = h.reader.read();
      await vi.advanceTimersByTimeAsync(10);
      expect(text(await read)).toBe(": keepalive\n\n");
    }
    const last = h.reader.read();
    await vi.advanceTimersByTimeAsync(5);
    expect(text(await last)).toContain("event: error");
    expect((await h.reader.read()).done).toBe(true);
    await h.source.cancelled;
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "STREAM_STALL_TIMEOUT" }));
    expect(h.complete.mock.calls[0]).toMatchObject([{ content: "", thinking: "" }, null, null, { outcome: "failed", usageSource: "unavailable" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queues at most one heartbeat under backpressure and cancels pending reads", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(35);
    // Only the watchdog remains: a full output queue has stopped heartbeat scheduling.
    expect(vi.getTimerCount()).toBe(1);
    expect(text(await h.reader.read())).toBe(": keepalive\n\n");
    await h.reader.cancel();
    await h.source.cancelled;
    expect(vi.getTimerCount()).toBe(0);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("inserts comments between complete frames and preserves split tool payloads", async () => {
    const h = harness();
    const tool = sseEvent("response.custom_tool_call_input.delta", { item_id: "call_test", delta: "print('test')" });
    h.source.write(tool.slice(0, 17));
    const read = h.reader.read();
    await vi.advanceTimersByTimeAsync(10);
    expect(text(await read)).toBe(": keepalive\n\n");
    h.source.write(tool.slice(17));
    expect(text(await h.reader.read())).toBe(tool);
    h.source.write(completed);
    expect(text(await h.reader.read())).toBe(completed + "data: [DONE]\n\n");
    expect((await h.reader.read()).done).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("allows zero to disable heartbeat without disabling the watchdog", async () => {
    const h = harness(0);
    let delivered = false;
    const pending = h.reader.read().then((result) => { delivered = true; return result; });
    await vi.advanceTimersByTimeAsync(40);
    expect(delivered).toBe(false);
    h.source.write(completed);
    expect(text(await pending)).toBe(completed + "data: [DONE]\n\n");
    await h.reader.read();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timers on setup failure", () => {
    const controller = createStreamController({ log: { errorLine() {} } });
    expect(() => pipeWithDisconnect(new Response(null), new TransformStream(), controller, null, 50, null, 10)).toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sets buffering protection on the real Codex Responses handler", async () => {
    const { response } = await handleStreamingResponse({
      providerResponse: new Response(completed, { headers: { "content-type": "text/event-stream" } }),
      provider: "codex", model: "gpt-6-astra", sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
      body: {}, stream: true, requestStartTime: Date.now(), streamController: createStreamController(),
    });
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.text()).toContain(completed);
    expect(vi.getTimerCount()).toBe(0);
  });
});
