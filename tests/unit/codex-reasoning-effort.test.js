import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";

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
});
