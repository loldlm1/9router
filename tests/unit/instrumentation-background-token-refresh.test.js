import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  capture: vi.fn(), installCatalog: vi.fn(), syncCatalog: vi.fn(),
  startRefresh: vi.fn(), stopRefresh: vi.fn(),
}));
vi.mock("@/lib/consoleLogBuffer", () => ({ initConsoleLogCapture: hooks.capture }));
vi.mock("open-sse/providers/catalogOverride.js", () => ({ installCatalogSource: hooks.installCatalog }));
vi.mock("@/lib/modelCatalog/sync.js", () => ({ startModelCatalogSync: hooks.syncCatalog }));
vi.mock("@/sse/services/backgroundTokenRefresh.js", () => ({
  startBackgroundTokenRefresh: hooks.startRefresh,
  stopBackgroundTokenRefresh: hooks.stopRefresh,
}));

import { register } from "../../src/instrumentation.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  hooks.startRefresh.mockReturnValue(true);
});

afterEach(() => {
  process.removeListener("SIGINT", hooks.stopRefresh);
  process.removeListener("SIGTERM", hooks.stopRefresh);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("background token refresh at Next startup", () => {
  it("starts before any request and registers cleanup alongside existing startup work", async () => {
    await register();

    expect(hooks.startRefresh).toHaveBeenCalledOnce();
    expect(hooks.capture).toHaveBeenCalledOnce();
    expect(hooks.installCatalog).toHaveBeenCalledOnce();
    expect(hooks.syncCatalog).toHaveBeenCalledOnce();
    expect(process.listeners("SIGINT")).toContain(hooks.stopRefresh);
    expect(process.listeners("SIGTERM")).toContain(hooks.stopRefresh);
  });

  it("does not register duplicate cleanup when refresh is disabled or already started", async () => {
    hooks.startRefresh.mockReturnValue(false);
    await register();

    expect(process.listeners("SIGINT")).not.toContain(hooks.stopRefresh);
    expect(process.listeners("SIGTERM")).not.toContain(hooks.stopRefresh);
  });

  it("keeps the server available if scheduler startup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    hooks.startRefresh.mockImplementationOnce(() => { throw new Error("synthetic startup failure"); });

    await expect(register()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[BackgroundTokenRefresh] scheduler start failed:", "synthetic startup failure");
    expect(process.listeners("SIGTERM")).not.toContain(hooks.stopRefresh);
  });

  it("skips Node-only startup on the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();

    expect(hooks.startRefresh).not.toHaveBeenCalled();
    expect(hooks.syncCatalog).not.toHaveBeenCalled();
  });
});
