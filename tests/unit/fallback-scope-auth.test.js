import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((provider) => provider),
  FREE_PROVIDERS: {},
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

describe("request-scoped fallback persistence", () => {
  it.each([
    [400, "Unsupported reasoning effort ultra"],
    [403, "GPT-6 Astra Pro mode is not available on this plan"],
  ])("does not read or write account state for deterministic status %s errors", async (status, message) => {
    const result = await markAccountUnavailable(
      "conn-1",
      status,
      message,
      "codex",
      "gpt-6-astra-pro",
      null,
      "request",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(dbMocks.getProviderConnections).not.toHaveBeenCalled();
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
