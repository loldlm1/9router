import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const { executeMock, forcedSSEToJsonMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  forcedSSEToJsonMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: forcedSSEToJsonMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

async function runNativeCodexRequest(model, reasoning) {
  const body = {
    model,
    input: "hello",
    stream: false,
    ...(reasoning ? { reasoning } : {}),
  };

  const result = await handleChatCore({
    body,
    modelInfo: { provider: "codex", model },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride: "openai-responses",
    clientRawRequest: {
      endpoint: "/v1/responses",
      body,
      headers: {
        accept: "application/json",
        "user-agent": "codex-cli/0.144.1",
      },
    },
  });

  return { body: executeMock.mock.calls.at(-1)?.[0]?.body, result };
}

describe("native Codex passthrough thinking suffixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async ({ model, body, stream, credentials }) => {
      const transformedBody = new CodexExecutor().transformRequest(model, body, stream, credentials);
      return {
        response: new Response("", { status: 200 }),
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers: {},
        transformedBody,
      };
    });
    forcedSSEToJsonMock.mockResolvedValue({
      success: true,
      response: new Response("{}", { status: 200 }),
    });
  });

  it("forwards Ultra for Sol", async () => {
    const { body } = await runNativeCodexRequest("gpt-5.6-sol(ultra)");

    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning).toEqual({ effort: "ultra", summary: "auto" });
  });

  it("converts unsupported Luna Ultra to Max without dropping reasoning metadata", async () => {
    const { body } = await runNativeCodexRequest("gpt-5.6-luna(ultra)", {
      effort: "low",
      summary: "detailed",
    });

    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "max", summary: "detailed" });
  });

  it("forwards Ultra through a Terra review alias", async () => {
    const { body } = await runNativeCodexRequest("gpt-5.6-terra-review(ultra)", {
      effort: "low",
    });

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning).toEqual({ effort: "ultra", summary: "auto" });
  });

  it.each([
    ["gpt-6-astra(max)", "max", undefined],
    ["gpt-6-astra-pro(low)", "low", "pro"],
    ["gpt-6-astra-review-xhigh", "xhigh", undefined],
  ])("normalizes native Astra route %s", async (model, effort, mode) => {
    const { body } = await runNativeCodexRequest(model);

    expect(body.model).toBe("gpt-6-astra");
    expect(body.reasoning).toEqual({
      effort,
      summary: "auto",
      ...(mode ? { mode } : {}),
    });
  });

  it("keeps explicit native Astra effort ahead of a suffix", async () => {
    const { body } = await runNativeCodexRequest("gpt-6-astra-review-low", {
      effort: "max",
      mode: "pro",
      summary: "detailed",
    });

    expect(body.model).toBe("gpt-6-astra");
    expect(body.reasoning).toEqual({ effort: "max", mode: "pro", summary: "detailed" });
  });

  it("returns an offline request-scoped error for invalid Astra suffixes", async () => {
    const { result } = await runNativeCodexRequest("gpt-6-astra(ultra)");

    expect(result).toMatchObject({ success: false, status: 400, fallbackScope: "request" });
    expect(result.error).toContain("Unsupported reasoning effort");
  });
});
