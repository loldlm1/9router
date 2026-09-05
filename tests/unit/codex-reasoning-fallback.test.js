import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor, classifyCodexFallbackScope } from "../../open-sse/executors/codex.js";
import { createErrorResult, parseUpstreamError } from "../../open-sse/utils/error.js";

const authMocks = vi.hoisted(() => ({
  acquireProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
const chatCoreMock = vi.hoisted(() => vi.fn());
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "codex", model: "gpt-6-astra-pro" })),
  getComboModels: vi.fn(async () => null),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: chatCoreMock }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: vi.fn() }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://127.0.0.1:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((handler) => handler),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/sse/utils/logger.js", () => loggerMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

function request() {
  return new Request("http://127.0.0.1:20128/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "cx/gpt-6-astra-pro", input: "Reply only OK" }),
  });
}

function account(id) {
  return { connectionId: id, connectionName: id, accessToken: `token-${id}` };
}

function acquisition(id) {
  return {
    credentials: account(id),
    lease: { release: vi.fn(() => true) },
  };
}

describe("Codex deterministic reasoning fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [400, "Unsupported reasoning mode pro", "unsupported_reasoning_mode", "gpt-6-astra", "request"],
    [404, "Model not found", "model_not_found", "gpt-6-astra", "request"],
    [422, "Invalid reasoning effort", "invalid_reasoning_effort", "gpt-6-astra", "request"],
    [403, "Your plan does not include Pro model access", "", "gpt-6-astra-pro", "request"],
    [403, "This model is still in rollout for your account", "model_not_available", "gpt-6-astra", "request"],
    [403, "Pro reasoning mode is unsupported", "unsupported_reasoning_mode", "gpt-6-astra", "request"],
    [403, "Pro", "", "gpt-6-astra-pro", "account"],
    [403, "Forbidden", "insufficient_permissions", "gpt-6-astra", "account"],
    [403, "Your plan does not include Pro model access", "", "gpt-5.6-sol-pro", "account"],
    [400, "Malformed request body", "bad_request", "gpt-6-astra", "account"],
    [401, "token_invalid", "token_invalid", "gpt-6-astra", "account"],
    [429, "usage_limit_reached", "usage_limit_reached", "gpt-6-astra", "account"],
    [503, "Selected model is at capacity", "model_at_capacity", "gpt-6-astra", "account"],
  ])("classifies status %s for %s as %s scope", (status, message, code, model, scope) => {
    expect(classifyCodexFallbackScope(status, message, code, model)).toBe(scope);
  });

  it("marks local reasoning validation failures as request-scoped 400s", () => {
    const executor = new CodexExecutor();
    try {
      executor.transformRequest("gpt-6-astra", {
        model: "gpt-6-astra",
        input: "hi",
        reasoning: { effort: "ultra" },
      }, true, {});
      throw new Error("expected transformRequest to fail");
    } catch (error) {
      expect(error.status).toBe(400);
      expect(error.fallbackScope).toBe("request");
    }
  });

  it("propagates executor fallback scope through the shared error contract", async () => {
    const executor = new CodexExecutor();
    const parsed = await parseUpstreamError(new Response(JSON.stringify({
      error: { message: "Unsupported reasoning effort max" },
    }), { status: 400 }), executor);
    expect(parsed).toMatchObject({ statusCode: 400, fallbackScope: "request" });
    expect(createErrorResult(parsed.statusCode, parsed.message, parsed.resetsAtMs, parsed.fallbackScope))
      .toMatchObject({ success: false, status: 400, fallbackScope: "request" });
  });

  it("preserves structured Astra entitlement errors as request scoped", async () => {
    const executor = new CodexExecutor();
    executor.transformRequest("gpt-6-astra-pro", {
      model: "gpt-6-astra-pro",
      input: "hi",
    }, true, {});

    const parsed = await parseUpstreamError(new Response(JSON.stringify({
      error: {
        message: "GPT-6 Astra Pro mode is not available on this plan",
        code: "model_not_available",
      },
    }), { status: 403 }), executor);

    expect(parsed).toMatchObject({
      statusCode: 403,
      message: "GPT-6 Astra Pro mode is not available on this plan",
      fallbackScope: "request",
    });
  });

  it("keeps invalid-token authorization failures account scoped", async () => {
    const executor = new CodexExecutor();
    executor.transformRequest("gpt-6-astra", {
      model: "gpt-6-astra",
      input: "hi",
    }, true, {});

    const parsed = await parseUpstreamError(new Response(JSON.stringify({
      error: { message: "The access token is invalid", code: "token_invalid" },
    }), { status: 403 }), executor);

    expect(parsed).toMatchObject({ statusCode: 403, fallbackScope: "account" });
  });

  it("returns a request-scoped error without locking or rotating accounts", async () => {
    const selected = acquisition("conn-1");
    authMocks.acquireProviderCredentials.mockResolvedValue(selected);
    chatCoreMock.mockResolvedValue(createErrorResult(
      400,
      "Unsupported reasoning mode pro",
      undefined,
      "request",
    ));

    const response = await handleChat(request());

    expect(response.status).toBe(400);
    expect(authMocks.acquireProviderCredentials).toHaveBeenCalledTimes(1);
    expect(selected.lease.release).toHaveBeenCalledTimes(1);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("keeps account fallback for quota errors", async () => {
    const first = acquisition("conn-1");
    const second = acquisition("conn-2");
    authMocks.acquireProviderCredentials
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1000 });
    chatCoreMock
      .mockResolvedValueOnce(createErrorResult(429, "usage_limit_reached", undefined, "account"))
      .mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200 }) });

    const response = await handleChat(request());
    await response.text();

    expect(response.status).toBe(200);
    expect(authMocks.acquireProviderCredentials).toHaveBeenCalledTimes(2);
    expect(first.lease.release).toHaveBeenCalledTimes(1);
    expect(second.lease.release).toHaveBeenCalledTimes(1);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1",
      429,
      "usage_limit_reached",
      "codex",
      "gpt-6-astra-pro",
      undefined,
      "account",
    );
  });
});
