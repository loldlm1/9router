import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDisconnectAwareStream, createStreamController } from "../../open-sse/utils/streamHandler.js";
import { createResponsesStreamLifecycle } from "../../open-sse/utils/responsesStreamHelpers.js";
import { handleStreamingResponse, buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { saveRequestDetail, saveRequestUsage } from "@/lib/usageDb.js";
import { controlledStream, deferred, socketError, sseEvent, readText } from "../helpers/codex-stream-fixtures.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());
const created = sseEvent("response.created", { sequence_number: 0, response: { id: "resp_test", status: "in_progress" } });
const completed = sseEvent("response.completed", { sequence_number: 1, response: { id: "resp_test", status: "completed" } });

async function harness(onStreamComplete = vi.fn()) {
  const upstream = controlledStream();
  const release = vi.fn();
  const onRequestSuccess = vi.fn();
  const streamController = createStreamController({ onDisconnect: release, onComplete: release, onError: release, log: { errorLine() {} } });
  const result = await handleStreamingResponse({
    providerResponse: new Response(upstream.stream, { headers: { "content-type": "text/event-stream" } }),
    provider: "codex", model: "gpt-6-astra", body: {}, stream: true, requestStartTime: Date.now(),
    sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
    streamController, onStreamComplete, onRequestSuccess,
  });
  return { upstream, release, streamController, onStreamComplete, onRequestSuccess, reader: result.response.body.getReader() };
}

async function nextText(reader) { return new TextDecoder().decode((await reader.read()).value); }

describe("Responses abort terminal synthesis", () => {
  it("reports a mid-stream reset after confirmed creation delivery once", async () => {
    const h = await harness();
    h.upstream.write(created);
    expect(await nextText(h.reader)).toBe(created);
    h.upstream.error(socketError());
    const failure = await nextText(h.reader);
    expect(failure).toContain('"response":{"id":"resp_test","status":"failed"');
    expect(failure.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect((await h.reader.read()).done).toBe(true);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(h.onStreamComplete.mock.calls[0][3].outcome).toBe("failed");
    expect(h.onRequestSuccess).not.toHaveBeenCalled();
  });

  it("preserves completed even when upstream resets and downstream cancels immediately after", async () => {
    const h = await harness();
    h.upstream.write(created);
    await h.reader.read();
    h.upstream.write(completed);
    expect(await nextText(h.reader)).toBe(completed + "data: [DONE]\n\n");
    h.upstream.error(socketError());
    await h.reader.cancel();
    expect(h.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(h.onStreamComplete.mock.calls[0][3].outcome).toBe("completed");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not treat a parsed but undelivered terminal as completed", async () => {
    const lifecycle = createResponsesStreamLifecycle();
    lifecycle.frame(new TextEncoder().encode(completed), "response.completed", { response: { id: "resp_test", status: "completed" } });
    lifecycle.onSettle = vi.fn();
    const source = new ReadableStream({ start(controller) { controller.error(socketError()); } });
    const stream = createDisconnectAwareStream(
      { readable: source, writable: { getWriter: () => ({ abort: async () => {} }) } },
      createStreamController({ log: { errorLine() {} } }), () => lifecycle.failureBytes(), lifecycle,
    );
    const output = await readText(stream);
    expect(output).toContain("event: response.failed");
    expect(output).not.toContain("event: response.completed");
    expect(lifecycle.onSettle.mock.calls[0][0].outcome).toBe("failed");
  });

  it("cancels upstream and cleans watchdogs once even when callbacks throw", async () => {
    vi.useFakeTimers();
    const h = await harness(vi.fn(() => { throw new Error("recording failed"); }));
    h.upstream.write(created);
    await h.reader.read();
    await h.reader.cancel("client_closed");
    await h.upstream.cancelled;
    await h.reader.cancel("again");
    expect(h.streamController.signal.aborted).toBe(true);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(h.onStreamComplete.mock.calls[0][3].outcome).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(h.onRequestSuccess).not.toHaveBeenCalled();
  });

  it("does not synthesize terminals for non-Responses streams", async () => {
    const source = controlledStream();
    const output = createDisconnectAwareStream(
      { readable: source.stream, writable: { getWriter: () => ({ abort: async () => {} }) } },
      createStreamController({ log: { errorLine() {} } }),
    );
    const reader = output.getReader();
    source.write("data: hi\n\n");
    expect(await nextText(reader)).toBe("data: hi\n\n");
    source.error(socketError());
    expect((await reader.read()).done).toBe(true);
  });
});

describe("stream detail settlement", () => {
  it.each(["completed", "failed", "incomplete", "cancelled"])("serializes delayed initial persistence before final %s, once", async (outcome) => {
    const initial = deferred();
    const final = deferred();
    saveRequestDetail.mockImplementationOnce(() => initial.promise).mockImplementationOnce(async (detail) => final.resolve(detail));
    const log = { line: vi.fn() };
    const { onStreamComplete } = buildOnStreamComplete({ provider: "codex", model: "gpt-6-astra", body: {}, requestStartTime: Date.now(), log });
    onStreamComplete.start({ status: "pending" });
    await Promise.resolve();
    const usage = { prompt_tokens: 10, completion_tokens: 3 };
    onStreamComplete({ content: "partial" }, usage, Date.now(), { outcome, usageSource: "upstream" });
    onStreamComplete({ content: "wrong" }, usage, Date.now(), { outcome: "completed" });
    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    initial.resolve();
    expect(await final.promise).toMatchObject({ status: outcome === "completed" ? "success" : "error", response: { outcome, content: "partial", usageSource: "upstream" }, tokens: usage });
    expect(saveRequestDetail).toHaveBeenCalledTimes(2);
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(log.line).toHaveBeenCalledTimes(outcome === "completed" ? 1 : 0);
  });
});
