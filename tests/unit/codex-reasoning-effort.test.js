import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const ASTRA_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ASTRA_ROUTES = [
  { route: "gpt-6-astra", mode: undefined },
  { route: "gpt-6-astra-pro", mode: "pro" },
  { route: "gpt-6-astra-review", mode: undefined },
];
const ASTRA_FORMS = [
  {
    name: "native",
    request: (route, effort) => ({ model: route, overrides: { reasoning: { effort, summary: "detailed" } }, summary: "detailed" }),
  },
  {
    name: "legacy",
    request: (route, effort) => ({ model: route, overrides: { reasoning_effort: effort }, summary: "auto" }),
  },
  {
    name: "hyphen suffix",
    request: (route, effort) => ({ model: `${route}-${effort}`, overrides: {}, summary: "auto" }),
  },
  {
    name: "parenthesized suffix",
    request: (route, effort) => ({ model: `${route}(${effort})`, overrides: {}, summary: "auto" }),
  },
];
const ASTRA_MATRIX = ASTRA_ROUTES.flatMap(({ route, mode }) =>
  ASTRA_EFFORTS.flatMap((effort) =>
    ASTRA_FORMS.map(({ name, request }) => ({ route, mode, effort, form: name, ...request(route, effort) })),
  ),
);

function transform(model, overrides = {}) {
  const executor = new CodexExecutor();
  return executor.transformRequest(model, {
    model,
    input: "Reply only OK",
    ...overrides,
  }, true, {});
}

describe("Codex reasoning effort capabilities", () => {
  it("preserves max through translation and executor normalization", () => {
    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "gpt-5.6-sol",
      { model: "gpt-5.6-sol", input: "Reply only OK", reasoning: { effort: "max" } },
      true,
      {},
      "codex",
    );

    expect(translated.reasoning_effort).toBe("max");
    expect(transform("gpt-5.6-sol", translated).reasoning.effort).toBe("max");
  });

  it.each(["sol", "terra", "luna"])("preserves max for GPT-5.6 %s", (variant) => {
    const body = transform(`gpt-5.6-${variant}`, { reasoning_effort: "max" });
    expect(body.model).toBe(`gpt-5.6-${variant}`);
    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  it("parses max suffix before resolving a review alias", () => {
    const body = transform("gpt-5.6-sol-review-max");
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning.effort).toBe("max");
  });

  it("keeps the legacy max to xhigh mapping for legacy models", () => {
    const body = transform("gpt-5.5", { reasoning: { effort: "max" } });
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it.each(["sol", "terra"])("preserves Ultra for GPT-5.6 %s", (variant) => {
    const body = transform(`gpt-5.6-${variant}`, { reasoning_effort: "ultra" });
    expect(body.reasoning.effort).toBe("ultra");
  });

  it("maps Luna Ultra to its supported Max effort", () => {
    expect(transform("gpt-5.6-luna", { reasoning_effort: "ultra" }).reasoning.effort).toBe("max");
  });

  it.each(ASTRA_MATRIX)("normalizes $route at $effort via $form", ({ model, mode, effort, overrides, summary }) => {
    const body = transform(model, overrides);

    expect(body.model).toBe("gpt-6-astra");
    expect(body.reasoning.effort).toBe(effort);
    expect(body.reasoning.summary).toBe(summary);
    expect(body.reasoning.mode).toBe(mode);
  });

  it("uses native effort before legacy effort and model suffix", () => {
    const body = transform("gpt-6-astra-review-low", {
      reasoning: { effort: "max" },
      reasoning_effort: "high",
    });

    expect(body.model).toBe("gpt-6-astra");
    expect(body.reasoning.effort).toBe("max");
  });

  it("preserves Astra precedence across Chat Completions translation", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "gpt-6-astra(max)",
      {
        model: "gpt-6-astra(max)",
        messages: [{ role: "user", content: "Reply only OK" }],
        reasoning: { effort: "high", mode: "pro", summary: "detailed" },
        reasoning_effort: "low",
      },
      true,
      {},
      "codex",
    );

    expect(translated.reasoning).toEqual({ effort: "high", mode: "pro", summary: "detailed" });
    expect(translated).not.toHaveProperty("reasoning_effort");
    expect(transform("gpt-6-astra(max)", translated).reasoning)
      .toEqual({ effort: "high", mode: "pro", summary: "detailed" });
  });

  it("uses legacy effort before the model suffix", () => {
    const body = transform("gpt-6-astra-pro-low", { reasoning_effort: "high" });

    expect(body.reasoning).toEqual({ effort: "high", summary: "auto", mode: "pro" });
  });

  it.each(ASTRA_ROUTES)("defaults $route to low", ({ route, mode }) => {
    const body = transform(route);

    expect(body.model).toBe("gpt-6-astra");
    expect(body.reasoning).toEqual({
      effort: "low",
      summary: "auto",
      ...(mode ? { mode } : {}),
    });
  });

  it.each(["none", "minimal", "ultra", "MAX", " max ", "turbo", ""])(
    "rejects unsupported Astra effort %j from request fields",
    (effort) => {
      expect(() => transform("gpt-6-astra", { reasoning: { effort } }))
        .toThrow(`Unsupported reasoning effort "${effort}" for Codex model "gpt-6-astra"`);
    },
  );

  it.each([
    "gpt-6-astra(none)",
    "gpt-6-astra(minimal)",
    "gpt-6-astra(ultra)",
    "gpt-6-astra(MAX)",
    "gpt-6-astra( max )",
    "gpt-6-astra(turbo)",
    "gpt-6-astra()",
    "gpt-6-astra-review-none",
    "gpt-6-astra-pro-ultra",
    "gpt-6-astra-review-MAX",
    "gpt-6-astra-review-turbo-fast",
    "gpt-6-astra-max ",
  ])("rejects unsupported Astra suffix in %s", (model) => {
    expect(() => transform(model)).toThrow(/Unsupported reasoning effort/);
  });

  it("fails invalid Astra effort before fetch", async () => {
    const fetchSpy = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockRejectedValue(new Error("fetch should not run"));

    try {
      await expect(new CodexExecutor().execute({
        model: "gpt-6-astra",
        body: { model: "gpt-6-astra", input: "Reply only OK", reasoning_effort: "ultra" },
        stream: true,
        credentials: { accessToken: "test" },
      })).rejects.toMatchObject({ status: 400, fallbackScope: "request" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
