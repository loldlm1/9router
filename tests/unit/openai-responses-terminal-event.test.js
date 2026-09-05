import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createResponsesFrameDecoder } from "../../open-sse/utils/responsesStreamHelpers.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { sseEvent, readText } from "../helpers/codex-stream-fixtures.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
}));

const encoder = new TextEncoder();
const created = sseEvent("response.created", { sequence_number: 0, response: { id: "resp_test", status: "in_progress" } });
const terminal = (type, status, extra = {}) => sseEvent(type, { sequence_number: 2, response: { id: "resp_test", ...(status && { status }), ...extra } });

async function runTransform(input) {
  const chunks = Array.isArray(input) ? input : [encoder.encode(input)];
  const stream = new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); } });
  return readText(stream.pipeThrough(createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex")));
}

describe("OpenAI Responses streaming termination", () => {
  it.each(["", "data: [DONE]\n\n"])("fails EOF/sentinel without a terminal, preserving ID and sequence: %j", async (suffix) => {
    const output = await runTransform(created + sseEvent("response.output_text.delta", { sequence_number: 1, delta: "partial" }) + suffix);
    expect(output).toContain('"sequence_number":2,"response":{"id":"resp_test","status":"failed"');
    expect(output).toContain('"delta":"partial"');
    expect(output).not.toContain("event: response.completed");
    expect(output.match(/event: response.failed/g)).toHaveLength(1);
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it.each([
    ["response.completed", "completed"], ["response.failed", "failed"],
    ["response.incomplete", "incomplete"], ["response.done", undefined], ["response.done", "failed"],
  ])("preserves %s (%s) and its reason without another terminal", async (type, status) => {
    const end = terminal(type, status, { incomplete_details: { reason: "max_output_tokens" } });
    const output = await runTransform(created + end + "data: [DONE]\n\n");
    expect(output).toBe(created + end + "data: [DONE]\n\n");
  });

  it("uses a generic error before a response identity is known", async () => {
    const output = await runTransform("");
    expect(output).toContain("event: error\n");
    expect(output).not.toContain('"id":');
    expect(output).not.toContain("event: response.completed");
  });

  it.each([
    "event: response.completed\n\n", "event: response.completed\ndata: {\"type\":\"response.completed\"}\n",
    "data: {invalid}\n\n", "data: null\n\n", "data: []\n\n",
    "event: response.completed\ndata: {\"type\":\"response.failed\"}\n\n",
    terminal("response.done", "in_progress"), terminal("response.completed", "failed"), sseEvent("response.completed"),
  ])("does not account malformed/partial data as successful: %j", async (bad) => {
    const output = await runTransform(created + bad);
    expect(output.match(/event: response.failed/g)).toHaveLength(1);
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it.each([
    sseEvent("response.completed", { response: { id: "other", status: "completed" } }),
    sseEvent("response.output_text.delta", { sequence_number: 0, delta: "duplicate" }),
  ])("rejects changed identities and non-increasing sequence numbers", async (bad) => {
    const output = await runTransform(created + bad);
    expect(output).toContain("event: response.failed");
    expect(output).not.toContain(bad);
  });

  it("preserves fragmented UTF-8, BOM, CRLF, comments, multiline JSON and tool payloads", async () => {
    const tool = 'event: response.function_call_arguments.delta\r\ndata: {"type":"response.function_call_arguments.delta",\r\ndata: "sequence_number":1,"item_id":"call_test","delta":"{\\"city\\":\\"\\u00e9\\"}"}\r\n\r\n';
    const input = encoder.encode("\uFEFF: caf\u00e9\r\n\r\n" + created.replaceAll("\n", "\r\n") + tool + terminal("response.completed", "completed").replaceAll("\n", "\r\n"));
    const output = await runTransform(Array.from(input, (byte) => new Uint8Array([byte])));
    expect(output).toBe(": caf\u00e9\n\n" + created + tool.replaceAll("\r\n", "\n") + terminal("response.completed", "completed") + "data: [DONE]\n\n");
  });

  it("supports CR framing, rejects truncated UTF-8, and bounds incomplete events", async () => {
    expect(await runTransform(terminal("response.completed", "completed").replaceAll("\n", "\r"))).toContain("event: response.completed");
    expect(await runTransform([encoder.encode(created), new Uint8Array([0xc3])])).toContain("event: response.failed");
    const decoder = createResponsesFrameDecoder(() => {}, 16);
    expect(() => decoder.push(encoder.encode("data: " + "x".repeat(11)))).toThrow("Invalid or truncated");
  });
});

describe("real streaming handler branch selection", () => {
  it.each(["codex-cli/1.0", "codex_cli_rs/1.0", "Droid/1.0", "unrelated", undefined])("enforces Responses outcomes for UA %s", async (userAgent) => {
    for (const outcome of ["completed", "failed", "incomplete", "eof"]) {
      const onComplete = vi.fn();
      const onStreamComplete = vi.fn();
      const onRequestSuccess = vi.fn();
      const end = outcome === "eof" ? "" : terminal(`response.${outcome}`, outcome, { usage: { input_tokens: 10, output_tokens: 3 } });
      const result = await handleStreamingResponse({
        providerResponse: new Response(created + end, { headers: { "content-type": "text/event-stream" } }),
        provider: "codex", model: "gpt-6-astra", body: {}, stream: true,
        sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES, userAgent,
        streamController: createStreamController({ onComplete }), onStreamComplete, onRequestSuccess, requestStartTime: Date.now(),
      });
      const output = await result.response.text();
      const expected = outcome === "eof" ? "failed" : outcome;
      expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
      expect(onStreamComplete.mock.calls[0][3]).toMatchObject({ outcome: expected, usageSource: outcome === "eof" ? "unavailable" : "upstream" });
      expect(onComplete).toHaveBeenCalledExactlyOnceWith(expected);
      expect(onRequestSuccess).toHaveBeenCalledTimes(outcome === "completed" ? 1 : 0);
    }
  });
});
