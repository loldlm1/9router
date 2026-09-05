import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexStreamDiagnostics, classifyCodexStreamError } from "../../open-sse/utils/codexObservability.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { controlledStream, socketError, sseEvent } from "../helpers/codex-stream-fixtures.js";

afterEach(() => vi.useRealTimers());

function trace() {
  const records = [];
  const log = {
    info: vi.fn((tag, line) => records.push(JSON.parse(line))),
    errorLine: vi.fn((tag, symbol, line) => records.push(JSON.parse(line.replace(/^CODEX_STREAM /, "")))),
  };
  const diagnostics = createCodexStreamDiagnostics({ log });
  diagnostics.beginAttempt();
  return { log, diagnostics, records: () => records };
}

describe("Codex stream diagnostics", () => {
  it("separates HTTP acceptance, preflight and a later socket failure", async () => {
    vi.useFakeTimers();
    const { log, diagnostics, records } = trace();
    await vi.advanceTimersByTimeAsync(20);
    diagnostics.headers(200);
    diagnostics.phase("preflight");
    await vi.advanceTimersByTimeAsync(10);
    const upstream = controlledStream();
    const controller = createStreamController({ provider: "codex", diagnostics, log });
    const output = pipeWithDisconnect(new Response(upstream.stream), new TransformStream(), controller);
    const reader = output.getReader();
    const firstRead = reader.read();
    const event = sseEvent("response.created", { response: { id: "resp_fixture" } });
    upstream.write(event);
    expect(new TextDecoder().decode((await firstRead).value)).toBe(event);
    await vi.advanceTimersByTimeAsync(50);
    upstream.error(socketError());
    expect((await reader.read()).done).toBe(true);
    expect(records()).toMatchObject([
      { outcome: "accepted", upstream_http_status: 200, headers_ms: 20 },
      { outcome: "failed", phase: "streaming", preflight_ms: 10, last_downstream_write_ms: 30, error_name: "TypeError", error_code: "UND_ERR_SOCKET" },
    ]);
    expect(log.errorLine).toHaveBeenCalledTimes(1);
    expect(log.errorLine.mock.calls[0][2]).not.toContain("synthetic socket close");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "STREAM_STALL_TIMEOUT", "CLIENT_CANCELLED"])("classifies %s separately", (code) => {
    expect(classifyCodexStreamError(Object.assign(new Error("PRIVATE PROMPT"), { code }))).toEqual({ error_name: "Error", error_code: code });
  });

  it("drops untrusted strings and bounds recursive causes", () => {
    const { diagnostics, records } = trace();
    const cause = { name: "secret@example.com\nINJECTED", code: "Bearer PRIVATE_TOKEN", message: "https://user:password@proxy.test", stack: "PRIVATE PROMPT" };
    cause.cause = cause;
    diagnostics.phase("PRIVATE PROMPT");
    diagnostics.event("PRIVATE PROMPT");
    diagnostics.finish("PRIVATE PROMPT", cause);
    const output = JSON.stringify(records());
    for (const forbidden of ["PRIVATE", "Bearer", "secret@", "password", "INJECTED"]) expect(output).not.toContain(forbidden);
    expect(output.length).toBeLessThan(1000);
  });

  it("correlates attempts but separates overlapping requests and settles once", () => {
    const first = trace();
    const second = trace();
    first.diagnostics.headers(503);
    first.diagnostics.beginAttempt();
    first.diagnostics.headers(200);
    first.diagnostics.finish("eof");
    first.diagnostics.finish("failed", socketError());
    expect(first.records().map(({ attempt, outcome }) => [attempt, outcome])).toEqual([[1, "accepted"], [1, "retry"], [2, "accepted"], [2, "eof"]]);
    expect(new Set(first.records().map((r) => r.request_id)).size).toBe(1);
    expect(first.diagnostics.requestId).not.toBe(second.diagnostics.requestId);
  });

  it("observes counters without retaining event data", () => {
    const { diagnostics } = trace();
    const chunk = new TextEncoder().encode("PRIVATE PROMPT");
    diagnostics.upstream(chunk);
    diagnostics.event("response.completed");
    expect(diagnostics.snapshot()).toMatchObject({ upstream_bytes: chunk.byteLength, upstream_chunks: 1, events: 1, terminal_event: "response.completed" });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain("PRIVATE");
  });
});
