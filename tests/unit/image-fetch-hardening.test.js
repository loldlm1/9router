import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS lookup so we control which host resolves to what IP.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mockFetchOnce(bytes, ok = true) {
  const body = {
    getReader() {
      let sent = false;
      return {
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) }),
        cancel: async () => {},
      };
    },
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, body })));
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]); // public by default
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("fetchImageAsBase64 hardening", () => {
  it("rejects non-http url", async () => {
    expect(await fetchImageAsBase64("ftp://x/y.png")).toBeNull();
    expect(await fetchImageAsBase64("data:image/png;base64,xx")).toBeNull();
  });

  it("SSRF: rejects private IP (10.x)", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    expect(await fetchImageAsBase64("http://internal.example/x.png")).toBeNull();
  });

  it("SSRF: rejects cloud metadata 169.254.169.254", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect(await fetchImageAsBase64("http://metadata/x.png")).toBeNull();
  });

  it("SSRF: rejects blocked hostname localhost", async () => {
    expect(await fetchImageAsBase64("http://localhost/x.png")).toBeNull();
  });

  it("SSRF: rejects IPv6 loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    expect(await fetchImageAsBase64("http://x/y.png")).toBeNull();
  });

  it("accepts valid PNG from public host", async () => {
    mockFetchOnce(PNG);
    const r = await fetchImageAsBase64("https://example.com/a.png");
    expect(r).not.toBeNull();
    expect(r.mimeType).toBe("image/png");
    expect(r.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects disguised non-image payload (magic byte mismatch)", async () => {
    mockFetchOnce(Buffer.from("<?php system($_GET[c]); ?>"));
    expect(await fetchImageAsBase64("https://example.com/evil.png")).toBeNull();
  });

  it("rejects payload over size cap", async () => {
    mockFetchOnce(Buffer.alloc(1024));
    expect(await fetchImageAsBase64("https://example.com/big.png", { maxBytes: 100 })).toBeNull();
  });

  it("returns null when fetch not ok", async () => {
    mockFetchOnce(PNG, false);
    expect(await fetchImageAsBase64("https://example.com/404.png")).toBeNull();
  });
});


describe("image prefetch cancellation budget", () => {
  it.each(["timeout", "client"])("retains both timeout and caller abort (%s)", async (cause) => {
    vi.useFakeTimers();
    let started;
    const fetched = new Promise((resolve) => { started = resolve; });
    let upstreamSignal;
    vi.stubGlobal("fetch", vi.fn((_url, { signal }) => {
      upstreamSignal = signal;
      started();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }));
    const abort = new AbortController();
    const pending = fetchImageAsBase64("https://example.com/a.png", { signal: abort.signal, timeoutMs: 20 });
    await fetched;
    if (cause === "timeout") await vi.advanceTimersByTimeAsync(20);
    else abort.abort();
    expect(await pending).toBeNull();
    expect(upstreamSignal.aborted).toBe(true);
    expect(abort.signal.aborted).toBe(cause === "client");
    expect(vi.getTimerCount()).toBe(0);
  });
});
