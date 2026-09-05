import { beforeEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  parseError: vi.fn(),
  refreshCredentials: vi.fn(async () => null),
}));
const refreshWithRetryMock = vi.hoisted(() => vi.fn(async (refresh) => refresh()));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executorMocks.execute,
    parseError: executorMocks.parseError,
    refreshCredentials: executorMocks.refreshCredentials,
  })),
}));
vi.mock("../../open-sse/services/provider.js", () => ({
  detectFormat: vi.fn(() => "openai-responses"),
  getTargetFormat: vi.fn(() => "openai-responses"),
  resolveTransport: vi.fn(() => null),
}));
vi.mock("../../open-sse/translator/index.js", () => ({
  register: vi.fn(),
  needsTranslation: vi.fn(() => false),
  translateRequest: vi.fn((_source, _target, upstreamModel, body) => ({ ...body, model: upstreamModel })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: refreshWithRetryMock }));
vi.mock("../../open-sse/translator/formats/claude.js", () => ({ normalizeClaudePassthrough: vi.fn() }));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({ compressWithPxpipe: vi.fn(async () => ({ summary: null })) }));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ model: body.model, stream })),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("chatCore request-scoped Codex failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executorMocks.execute.mockReset();
    executorMocks.parseError.mockImplementation((response, bodyText) => {
      const error = JSON.parse(bodyText).error;
      return {
        status: response.status,
        message: error.message,
        fallbackScope: error.code === "model_not_available" ? "request" : "account",
      };
    });
    executorMocks.refreshCredentials.mockResolvedValue(null);
  });

  it("preserves status and fallback scope from executor validation", async () => {
    const error = new Error("Unsupported reasoning effort ultra");
    error.status = 400;
    error.fallbackScope = "request";
    executorMocks.execute.mockRejectedValue(error);
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      errorLine: vi.fn(),
      line: vi.fn(),
    };

    const result = await handleChatCore({
      body: {
        model: "codex/gpt-6-astra",
        input: "PRIVATE PROMPT",
        reasoning: { effort: "ultra" },
      },
      modelInfo: { provider: "codex", model: "gpt-6-astra" },
      credentials: { accessToken: "secret-token", connectionId: "conn-1" },
      log,
      connectionId: "conn-1",
      sourceFormatOverride: "openai-responses",
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: { model: "cx/gpt-6-astra", input: "PRIVATE PROMPT" },
        headers: {},
      },
    });

    expect(result).toMatchObject({ success: false, status: 400, fallbackScope: "request" });
    expect(result.response.status).toBe(400);
    const routeLine = log.info.mock.calls.find(([topic]) => topic === "CODEX_ROUTE")?.[1];
    expect(routeLine).toContain("fallback_scope=request");
    expect(routeLine).not.toContain("PRIVATE PROMPT");
    expect(routeLine).not.toContain("secret-token");
  });

  it("does not refresh or retry an Astra entitlement rejection", async () => {
    executorMocks.execute.mockResolvedValue({
      response: new Response(JSON.stringify({
        error: {
          message: "GPT-6 Astra Pro mode is not available on this plan",
          code: "model_not_available",
        },
      }), { status: 403 }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: {
        model: "gpt-6-astra",
        reasoning: { effort: "max", mode: "pro", summary: "auto" },
      },
    });

    const result = await handleChatCore({
      body: {
        model: "codex/gpt-6-astra-pro",
        input: "PRIVATE PROMPT",
        reasoning: { effort: "max" },
      },
      modelInfo: { provider: "codex", model: "gpt-6-astra-pro" },
      credentials: { accessToken: "secret-token", connectionId: "conn-1" },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn(), line: vi.fn() },
      connectionId: "conn-1",
      sourceFormatOverride: "openai-responses",
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: { model: "cx/gpt-6-astra-pro", input: "PRIVATE PROMPT" },
        headers: {},
      },
    });

    expect(result).toMatchObject({ success: false, status: 403, fallbackScope: "request" });
    expect(executorMocks.execute).toHaveBeenCalledTimes(1);
    expect(refreshWithRetryMock).not.toHaveBeenCalled();
    expect(executorMocks.refreshCredentials).not.toHaveBeenCalled();
  });

  it("keeps generic forbidden errors on the credential-refresh path", async () => {
    executorMocks.execute.mockResolvedValue({
      response: new Response(JSON.stringify({
        error: { message: "Forbidden", code: "insufficient_permissions" },
      }), { status: 403 }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: { model: "gpt-6-astra" },
    });

    const result = await handleChatCore({
      body: { model: "codex/gpt-6-astra", input: "hello" },
      modelInfo: { provider: "codex", model: "gpt-6-astra" },
      credentials: { accessToken: "secret-token", connectionId: "conn-1" },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn(), line: vi.fn() },
      connectionId: "conn-1",
      sourceFormatOverride: "openai-responses",
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: { model: "cx/gpt-6-astra", input: "hello" },
        headers: {},
      },
    });

    expect(result).toMatchObject({ success: false, status: 403, fallbackScope: "account" });
    expect(refreshWithRetryMock).toHaveBeenCalledTimes(1);
    expect(executorMocks.refreshCredentials).toHaveBeenCalledTimes(1);
  });
});
