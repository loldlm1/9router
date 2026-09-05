import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";
import { proxyAwareFetch, getCodexDispatcher, closeCodexDispatchers } from "../../open-sse/utils/proxyFetch.js";
import { listenLoopback, listenConnectProxy } from "../helpers/codex-socket-fixtures.js";

const resources = [];
const policy = { connectTimeoutMs: 1000, headersTimeoutMs: 120, bodyTimeoutMs: 120 };
beforeEach(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(key, "");
  vi.stubEnv("NO_PROXY", "*");
});
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
  await closeCodexDispatchers();
  vi.unstubAllEnvs();
});

describe("Codex real native fetch timeout policy", () => {
  it.each(["direct", "connection_proxy", "env_proxy", "relay"])("enforces body idle timeout over %s", async (route) => {
    let received;
    const origin = await listenLoopback((req, res) => {
      received = { url: req.url, relayTarget: req.headers["x-relay-target"], proxyAuth: req.headers["proxy-authorization"] };
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": first\n\n");
    });
    resources.push(origin);
    let proxy;
    let proxyOptions = null;
    if (route.includes("proxy")) {
      proxy = await listenConnectProxy([origin.origin]);
      resources.push(proxy);
      if (route === "connection_proxy") proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: proxy.origin };
      else { vi.stubEnv("HTTP_PROXY", proxy.origin); vi.stubEnv("NO_PROXY", ""); }
    }
    if (route === "relay") proxyOptions = { vercelRelayUrl: `${origin.origin}/relay` };
    const response = await proxyAwareFetch(`${origin.origin}/responses`, { method: "POST", body: "synthetic", signal: AbortSignal.timeout(3000) }, proxyOptions, policy);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": first\n\n");
    await expect(reader.read()).rejects.toMatchObject({ cause: { code: "UND_ERR_BODY_TIMEOUT" } });
    reader.releaseLock();
    expect(received.proxyAuth).toBeUndefined();
    if (proxy) expect(proxy.tunnels).toBe(1);
    if (route === "relay") expect(received).toMatchObject({ url: "/relay", relayTarget: origin.origin });
  });

  it("distinguishes a headers timeout before any response bytes", async () => {
    const origin = await listenLoopback((req) => req.resume());
    resources.push(origin);
    await expect(proxyAwareFetch(origin.origin, { signal: AbortSignal.timeout(3000) }, null, policy)).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
  });

  it("reuses scoped pools, preserves other callers' dispatcher, and never bypasses a failed proxy", async () => {
    let directRequests = 0;
    const origin = await listenLoopback((_req, res) => { directRequests++; res.end("ok"); });
    const rejectedProxy = await listenLoopback((_req, res) => { res.writeHead(502); res.end(); });
    rejectedProxy.server.on("connect", (_req, socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
    resources.push(origin, rejectedProxy);
    expect(getCodexDispatcher(null, policy)).toBe(getCodexDispatcher(null, { ...policy }));
    expect(getCodexDispatcher(rejectedProxy.origin, policy)).not.toBe(getCodexDispatcher(null, policy));
    const agent = new Agent();
    const observed = [];
    const dispatcher = { dispatch(options, handler) { observed.push(options); return agent.dispatch(options, handler); } };
    try {
      expect(await (await proxyAwareFetch(origin.origin, { dispatcher })).text()).toBe("ok");
      expect(observed).toHaveLength(1);
      expect(observed[0].bodyTimeout).not.toBe(policy.bodyTimeoutMs);
      await expect(proxyAwareFetch(origin.origin, { method: "POST", body: "synthetic", signal: AbortSignal.timeout(3000) }, { connectionProxyEnabled: true, connectionProxyUrl: rejectedProxy.origin }, policy)).rejects.toThrow();
      expect(directRequests).toBe(1);
    } finally { await agent.close(); }
  });
});

describe("Codex resolved configuration", () => {
  it("uses finite defaults and keeps body timeout above router idle by the cleanup margin", async () => {
    vi.stubEnv("STREAM_STALL_TIMEOUT_MS", "360000");
    for (const value of ["0", "-1", "Infinity", "12junk", "999999999999"]) {
      vi.stubEnv("CODEX_STREAM_STALL_TIMEOUT_MS", value);
      vi.stubEnv("CODEX_SSE_PEEK_TIMEOUT_MS", value);
      vi.stubEnv("CODEX_FETCH_BODY_TIMEOUT_MS", value);
      vi.resetModules();
      const config = await import("../../open-sse/config/runtimeConfig.js");
      expect(config.CODEX_STREAM_STALL_TIMEOUT_MS).toBe(360000);
      expect(config.CODEX_SSE_PEEK_TIMEOUT_MS).toBe(1000);
      expect(config.CODEX_TRANSPORT_TIMEOUTS.bodyTimeoutMs).toBe(390000);
    }
    vi.stubEnv("CODEX_STREAM_STALL_TIMEOUT_MS", "600000");
    vi.stubEnv("CODEX_FETCH_BODY_TIMEOUT_MS", "100");
    vi.stubEnv("CODEX_STREAM_HEARTBEAT_MS", "0");
    vi.resetModules();
    const config = await import("../../open-sse/config/runtimeConfig.js");
    expect(config.CODEX_TRANSPORT_TIMEOUTS.bodyTimeoutMs).toBe(630000);
    expect(config.CODEX_STREAM_HEARTBEAT_MS).toBe(0);
  });
});
