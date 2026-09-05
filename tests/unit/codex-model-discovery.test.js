import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  refreshCodexToken: mocks.refreshCodexToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
const originalFetch = global.fetch;

const connection = {
  id: "codex-connection",
  provider: "codex",
  accessToken: "access-token",
  refreshToken: "refresh-token",
};

async function fetchModels() {
  const response = await GET(
    new Request("https://router.test/api/providers/codex-connection/models"),
    { params: Promise.resolve({ id: connection.id }) },
  );
  return { response, body: await response.json() };
}

describe("Codex account model discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({ ...connection });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("merges an account-visible Astra row with exactly three public routes", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6 Astra (live)", type: "chat" },
        { id: "gpt-6-astra", description: "duplicate partial row" },
        { id: "gpt-5.5-image", name: "GPT 5.5 Image", type: "image" },
      ],
    }), { status: 200 }));

    const { response, body } = await fetchModels();
    const astra = body.models.filter((model) => model.id.startsWith("gpt-6-astra"));

    expect(response.status).toBe(200);
    expect(astra.map((model) => model.id).sort()).toEqual([
      "gpt-6-astra",
      "gpt-6-astra-pro",
      "gpt-6-astra-review",
    ]);
    expect(astra).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gpt-6-astra",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        reasoningModes: ["standard", "pro"],
      }),
      expect.objectContaining({
        id: "gpt-6-astra-pro",
        upstreamModelId: "gpt-6-astra",
        reasoningMode: "pro",
      }),
      expect.objectContaining({
        id: "gpt-6-astra-review",
        upstreamModelId: "gpt-6-astra",
        quotaFamily: "review",
      }),
    ]));
    expect(body.models.some((model) => model.id === "gpt-5.5-image-review")).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("client_version=0.153.0"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "codex_cli_rs/0.153.0",
        }),
      }),
    );
  });

  it("does not advertise Astra when a successful account catalog omits it", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
    }), { status: 200 }));

    const { body } = await fetchModels();

    expect(body.models.some((model) => model.id.startsWith("gpt-6-astra"))).toBe(false);
    expect(body.models.map((model) => model.id)).toEqual(["gpt-5.5", "gpt-5.5-review"]);
  });

  it("refreshes once and expands Astra from the refreshed catalog", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ id: "gpt-6-astra" }],
      }), { status: 200 }));
    mocks.refreshCodexToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
    });

    const { body } = await fetchModels();

    expect(body.models.filter((model) => model.id.startsWith("gpt-6-astra"))).toHaveLength(3);
    expect(mocks.updateProviderCredentials).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
    }));
    expect(global.fetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer new-access-token" }),
      }),
    );
  });

  it("falls back to the static catalog only when the live catalog is unavailable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("catalog offline"));

    const { body } = await fetchModels();

    expect(body.warning).toContain("catalog offline");
    expect(body.models.filter((model) => model.id.startsWith("gpt-6-astra"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-6-astra" }),
      expect.objectContaining({ id: "gpt-6-astra-pro" }),
      expect.objectContaining({ id: "gpt-6-astra-review" }),
    ]));
  });
});
