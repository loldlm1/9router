import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
} from "../../open-sse/config/codexConstants.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import codexImageProvider from "../../open-sse/handlers/imageProviders/codex.js";

const SOURCE_FILES = [
  "open-sse/providers/registry/codex.js",
  "open-sse/handlers/imageProviders/codex.js",
  "src/app/api/providers/[id]/models/route.js",
  "src/app/api/providers/[id]/test/testUtils.js",
];

describe("Codex client identity", () => {
  it("uses the Astra-capable client generation on runtime request paths", () => {
    expect(CODEX_CLIENT_VERSION).toBe("0.153.0");
    expect(CODEX_USER_AGENT).toBe("codex_cli_rs/0.153.0");
    expect(PROVIDERS.codex.headers).toMatchObject({
      originator: CODEX_ORIGINATOR,
      "User-Agent": CODEX_USER_AGENT,
    });

    expect(codexImageProvider.buildHeaders({ accessToken: "token" })).toMatchObject({
      originator: CODEX_ORIGINATOR,
      "user-agent": CODEX_USER_AGENT,
      version: CODEX_CLIENT_VERSION,
    });
  });

  it("keeps request, image, test, and catalog sources free of drifted versions", () => {
    for (const file of SOURCE_FILES) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/codex_cli_rs\/\d+\.\d+\.\d+/);
      expect(source, file).toMatch(/CODEX_(?:CLIENT_VERSION|USER_AGENT)/);
    }

    const catalogSource = readFileSync(
      new URL("../../src/app/api/providers/[id]/models/route.js", import.meta.url),
      "utf8",
    );
    expect(catalogSource).toContain("client_version=${CODEX_CLIENT_VERSION}");
  });
});
