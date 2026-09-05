import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { isCodexAstraModel, CODEX_SSE_RETRY_PATTERNS, CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS } from "../config/codexConstants.js";
import { PROVIDERS } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/formats/responsesApi.js";
import { fetchImageAsBase64 } from "../translator/concerns/image.js";
import {
  getModelReasoningEfforts,
  getModelReasoningMode,
  getModelReasoningModes,
  getModelUpstreamId,
} from "../config/providerModels.js";
import { DEFAULT_RETRY_CONFIG, HTTP_STATUS, resolveRetryEntry, CODEX_SSE_PEEK_TIMEOUT_MS, CODEX_SSE_PEEK_BYTES, CODEX_TRANSPORT_TIMEOUTS } from "../config/runtimeConfig.js";
import { FALLBACK_SCOPE_ACCOUNT, FALLBACK_SCOPE_REQUEST } from "../services/fallbackScope.js";
import { dbg } from "../utils/debugLog.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { createResponsesFrameDecoder } from "../utils/responsesStreamHelpers.js";
import { setTimeout as delay } from "node:timers/promises";

// SSE error patterns inside 200-OK bodies. Some retry same account first; capacity rotates accounts.
const CODEX_MODEL_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";
const CODEX_INVALID_REQUEST_STATUSES = new Set([400, 404, 422]);
const CODEX_MODEL_REASONING_ERROR_PATTERNS = [
  /(?:unsupported|invalid|unknown|not found|not available).*(?:reasoning|effort|mode|model)/i,
  /(?:reasoning|effort|mode|model).*(?:unsupported|invalid|unknown|not found|not available|not supported|does not support)/i,
];
const CODEX_MODEL_REASONING_CODE_PATTERNS = [
  /^(?:invalid|unsupported|unknown)_(?:model|reasoning|reasoning_effort|reasoning_mode)$/i,
  /^model_(?:not_found|not_available|unsupported|unknown)$/i,
];
const CODEX_ASTRA_ACCESS_PATTERNS = [
  /(?:gpt-6-astra|model|pro mode|reasoning mode).*(?:not available|unavailable|not enabled|not supported|unsupported|does not support|no access|access denied|entitlement|subscription|plan|required|rollout)/i,
  /(?:access|entitlement|subscription|plan|rollout).*(?:gpt-6-astra|model|pro mode|reasoning mode)/i,
];
const CODEX_ASTRA_ACCESS_CODE_PATTERNS = [
  /^(?:invalid|unsupported)_(?:model|reasoning_effort|reasoning_mode)$/i,
  /^model_(?:not_available|access_denied|entitlement_required)$/i,
  /^(?:entitlement|subscription|plan)_(?:required|missing|unsupported)$/i,
  /^(?:pro_mode|reasoning_mode)_(?:not_available|not_supported|requires_pro)$/i,
];

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search"
]);

// Responses-native freeform tools carry a name plus format payload and must pass through intact.
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
  "text"
]);

// Convert role=system → role=developer in body.input (keeps content in cacheable prefix)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

// Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false
function stripStoredItemReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) delete item.id;
    }
    return true;
  });
}

// Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools
function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    const parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(name);
    return true;
  });
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Resolve prompt-cache session id: client session → assistant-text-hash → workspaceId → connection
function resolveCacheSessionId(body, credentials) {
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "codex"
  });
}

const CODEX_REASONING_EFFORT_SUFFIXES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObjectRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

function splitReasoningEffortSuffix(modelId) {
  if (typeof modelId !== "string") return { modelId, effort: null, hasEffort: false };

  const parenthesized = modelId.match(/^(.*)\(([^()]*)\)\s*$/);
  if (parenthesized) {
    return {
      modelId: parenthesized[1].trim(),
      effort: parenthesized[2],
      hasEffort: true,
    };
  }

  // An exact configured model such as "gpt-5.6-sol-pro" is not a suffix form.
  if (getModelReasoningEfforts("cx", modelId)) {
    return { modelId, effort: null, hasEffort: false };
  }

  for (const effort of CODEX_REASONING_EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (modelId.endsWith(suffix)) {
      return { modelId: modelId.slice(0, -suffix.length), effort, hasEffort: true };
    }
  }

  // When the base route has an explicit effort contract, treat any remaining
  // hyphen tail as an attempted suffix so invalid values fail locally.
  let separator = modelId.lastIndexOf("-");
  while (separator > 0) {
    const baseId = modelId.slice(0, separator);
    if (getModelReasoningEfforts("cx", baseId)) {
      return {
        modelId: baseId,
        effort: modelId.slice(separator + 1),
        hasEffort: true,
      };
    }
    separator = modelId.lastIndexOf("-", separator - 1);
  }

  return { modelId, effort: null, hasEffort: false };
}

export function classifyCodexFallbackScope(status, message = "", code = "", modelId = "") {
  const numericStatus = Number(status);
  const messageText = String(message || "");
  const codeText = String(code || "");

  if (
    CODEX_INVALID_REQUEST_STATUSES.has(numericStatus) &&
    (
      CODEX_MODEL_REASONING_ERROR_PATTERNS.some((pattern) => pattern.test(messageText)) ||
      CODEX_MODEL_REASONING_CODE_PATTERNS.some((pattern) => pattern.test(codeText))
    )
  ) {
    return FALLBACK_SCOPE_REQUEST;
  }

  if (
    numericStatus === HTTP_STATUS.FORBIDDEN &&
    isCodexAstraModel(modelId) &&
    (
      CODEX_ASTRA_ACCESS_PATTERNS.some((pattern) => pattern.test(messageText)) ||
      CODEX_ASTRA_ACCESS_CODE_PATTERNS.some((pattern) => pattern.test(codeText))
    )
  ) return FALLBACK_SCOPE_REQUEST;

  return FALLBACK_SCOPE_ACCOUNT;
}

function codexRequestError(message) {
  const error = new Error(message);
  error.status = HTTP_STATUS.BAD_REQUEST;
  error.fallbackScope = FALLBACK_SCOPE_REQUEST;
  return error;
}

function normalizeReasoningEffort(value, supportedEfforts, modelId) {
  if (supportedEfforts) {
    if (supportedEfforts.includes(value)) return value;
    if (value === "ultra" && supportedEfforts.includes("max") && modelId.includes("luna")) return "max";
    throw codexRequestError(`Unsupported reasoning effort "${String(value)}" for Codex model "${modelId}"`);
  }
  if (!value) return value;
  if (value === "max") return "xhigh";
  return value;
}

function normalizeReasoningMode(value, supportedModes, modelId, supplied = false) {
  if (!supplied && (value == null || value === "")) return null;
  if (!supportedModes || supportedModes.includes(value)) return value;
  throw codexRequestError(`Unsupported reasoning mode "${String(value)}" for Codex model "${modelId}"`);
}

function findNestedMessage(value, depth = 0) {
  if (!value || depth > 6 || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
  if (typeof value.response?.error?.message === "string" && value.response.error.message.trim()) return value.response.error.message;
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findNestedErrorCode(value, depth = 0) {
  if (!value || depth > 6 || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedErrorCode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ["code", "error_code", "errorCode"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findNestedErrorCode(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseCodexErrorBody(bodyText) {
  try {
    const value = JSON.parse(bodyText);
    return {
      message: findNestedMessage(value),
      code: findNestedErrorCode(value),
    };
  } catch {
    return { message: null, code: null };
  }
}

function codexSseErrorResponse(status, message) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error",
    }
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
    this._currentSessionId = null;
    this._isCompact = false;
    this._requestedModelId = null;
    this._upstreamModelId = null;
  }

  /**
   * Override headers to add codex-specific identity headers.
   * transformRequest runs BEFORE buildHeaders, sets this._currentSessionId.
   */
  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    headers["session_id"] = this._currentSessionId || credentials?.connectionId || "default";
    // Identify client type to Codex backend (matches official codex CLI)
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";
    // Account/workspace binding header — required when multiple Codex accounts
    // are configured. OAuth import stores ChatGPT account ID as chatgptAccountId;
    // older/custom rows may use workspaceId/accountId. Prefer explicit workspaceId
    // but fall back to chatgptAccountId so requests don't cross-bind to the wrong
    // OpenAI account and surface as token_invalid after adding another account.
    const accountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (typeof accountId === "string" && accountId && !headers["ChatGPT-Account-ID"]) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return this._isCompact ? `${base}/compact` : base;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body, signal) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000, signal });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  async execute(args) {
    args.signal?.throwIfAborted();
    // BaseExecutor resolves the URL before calling transformRequest(), so capture
    // the endpoint choice here to keep normal and compact requests independent.
    this._isCompact = !!args.body?._compact;
    const imgCount = Array.isArray(args.body?.input) ? args.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0) : 0;
    const inputLen = Array.isArray(args.body?.input) ? args.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${this._currentSessionId || "pending"}`);
    if (imgCount > 0) {
      const t0 = Date.now();
      await this.prefetchImages(args.body, args.signal);
      dbg("CODEX", `prefetchImages done | ${Date.now() - t0}ms`);
    } else {
      await this.prefetchImages(args.body, args.signal);
    }

    // Retry loop for SSE-level overloaded errors (200 OK body contains event: error)
    // Reuses 503 retry config — same semantic: upstream temporarily unavailable
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const { attempts, delayMs } = resolveRetryEntry(retryConfig[503]);
    const retryBudget = { remaining: Math.max(...Object.values(retryConfig).map((entry) => resolveRetryEntry(entry).attempts)) };
    let attempt = 0;
    while (true) {
      args.signal?.throwIfAborted();
      const result = await super.execute({ ...args, retryBudget, transportPolicy: this._isCompact ? null : CODEX_TRANSPORT_TIMEOUTS });
      args.diagnostics?.phase("preflight");
      let peek;
      try { peek = await this._peekSseTransientError(result.response, { signal: args.signal }); }
      catch (error) { error.fallbackScope = FALLBACK_SCOPE_REQUEST; throw error; }
      if (!peek.matched) {
        // Replace body with re-assembled stream (prefix bytes already read + rest)
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      if (peek.accountFallback) {
        args.log?.warn?.("RETRY", `CODEX | SSE account fallback "${peek.message}"`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || CODEX_MODEL_CAPACITY_MESSAGE);
        return result;
      }
      if (attempt >= attempts || retryBudget.remaining <= 0) {
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${attempt}/${attempts})`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
        return result;
      }
      attempt++;
      retryBudget.remaining--;
      args.log?.debug?.("RETRY", `CODEX | SSE "${peek.matched}" retry ${attempt}/${attempts} after ${delayMs / 1000}s`);
      dbg("CODEX", `SSE overloaded "${peek.matched}" → retry ${attempt}/${attempts} in ${delayMs}ms`);
      await delay(delayMs, undefined, { signal: args.signal });
    }
  }

  // Keep one reader (and at most one pending read) across the bounded preflight.
  async _peekSseTransientError(response, { signal, timeoutMs = CODEX_SSE_PEEK_TIMEOUT_MS, maxBytes = CODEX_SSE_PEEK_BYTES } = {}) {
    signal?.throwIfAborted();
    if (!response?.ok || !response.body || !(response.headers.get("content-type") || "").includes("text/event-stream")) {
      return { matched: null, replacementBody: null };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let pendingRead = null;
    let eof = false;
    let stopped = false;
    let cancelled = false;
    let released = false;
    let outputController;
    let matched = null;
    let message = null;
    let accountFallback = false;
    let bytes = 0;
    let timer;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    };
    const cancel = async (reason) => {
      cancelled = true;
      try { await reader.cancel(reason); } catch { /* stream may already be errored */ }
      finally { release(); }
    };
    const onAbort = () => {
      const error = new DOMException("Request aborted", "AbortError");
      rejectAbort(error);
      outputController?.error(error);
      void cancel(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const decoder = createResponsesFrameDecoder(({ event, data, done }) => {
      if (!data && !done) return;
      // Only structured rejection envelopes are retryable, never ordinary text.
      const error = data?.error || data?.response?.error || (event === "error" ? data : null);
      if (error && (!event || event === "error" || event === "response.failed")) {
        const text = [error.code, error.type, error.message].filter((part) => typeof part === "string").join(" ").toLowerCase();
        matched = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.find((pattern) => text.includes(pattern)) || null;
        accountFallback = !!matched;
        matched ||= CODEX_SSE_RETRY_PATTERNS.find((pattern) => text.includes(pattern)) || null;
        if (matched) message = typeof error.message === "string" ? error.message : matched;
      }
      stopped = true;
      return false;
    }, maxBytes);
    try {
      signal?.throwIfAborted();
      while (!stopped && bytes < maxBytes) {
        pendingRead ||= reader.read();
        const read = await Promise.race([pendingRead, deadline, aborted]);
        if (!read) break;
        pendingRead = null;
        if (read.done) { eof = true; break; }
        chunks.push(read.value);
        const prefix = read.value.subarray(0, maxBytes - bytes);
        bytes += read.value.byteLength;
        // The live Responses path owns malformed/oversized protocol failures.
        try { decoder.push(prefix); } catch { stopped = true; }
      }
      if (matched) {
        await cancel();
        return { matched, message, accountFallback, replacementBody: null };
      }
    } catch (error) {
      await cancel(error);
      throw error;
    } finally { clearTimeout(timer); }

    const replacementBody = new ReadableStream({
      start(controller) { outputController = controller; },
      async pull(controller) {
        if (cancelled) return;
        if (chunks.length) { controller.enqueue(chunks.shift()); return; }
        if (eof) { release(); controller.close(); return; }
        try {
          const { done, value } = await (pendingRead ||= reader.read());
          pendingRead = null;
          if (cancelled) return;
          if (done) { release(); controller.close(); return; }
          controller.enqueue(value);
        } catch (error) {
          if (!cancelled) { release(); controller.error(error); }
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    return { matched: null, message: null, accountFallback: false, replacementBody };
  }

  // Parse Codex usage_limit_reached to extract precise resetsAtMs; fallback to default otherwise
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return { status: 429, message: err.message || bodyText, resetsAtMs, fallbackScope: FALLBACK_SCOPE_ACCOUNT };
          }
        }
      } catch { /* fall through to default */ }
    }
    const parsed = super.parseError(response, bodyText);
    const details = parseCodexErrorBody(bodyText);
    const message = details.message || parsed.message || bodyText;
    return {
      ...parsed,
      message,
      fallbackScope: classifyCodexFallbackScope(
        parsed.status || response.status,
        message,
        details.code,
        this._requestedModelId || this._upstreamModelId,
      ),
    };
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    if (Object.prototype.hasOwnProperty.call(body, "_compact")) {
      this._isCompact = !!body._compact;
    }
    delete body._compact;
    // Resolve conversation-stable session_id (priority: body → assistant-text → workspace → machine)
    this._currentSessionId = resolveCacheSessionId(body, credentials);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }

    // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
    convertSystemToDeveloperRole(body);
    // Strip server-generated item IDs (rs_/fc_/resp_/msg_) — Codex /responses can't resolve when store=false
    stripStoredItemReferences(body);
    // Flatten function tools + drop unsupported types
    normalizeCodexTools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!body.instructions || body.instructions.trim() === "") {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Inject prompt_cache_key for stable Codex prompt caching
    if (!body.prompt_cache_key && this._currentSessionId) {
      body.prompt_cache_key = this._currentSessionId;
    }

    // Extract thinking level from the requested model before resolving virtual aliases.
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    // `body.model` may already be the upstream id because chatCore resolves
    // virtual models before dispatch. Keep the route-level model for metadata.
    const requested = splitReasoningEffortSuffix(model || body.model);
    const supportedEfforts = getModelReasoningEfforts("cx", requested.modelId);
    const supportedModes = getModelReasoningModes("cx", requested.modelId);
    const aliasMode = getModelReasoningMode("cx", requested.modelId);
    body.model = getModelUpstreamId("cx", requested.modelId);
    this._requestedModelId = requested.modelId;
    this._upstreamModelId = body.model;

    // Priority: explicit reasoning.effort > reasoning_effort > suffix > default.
    const reasoning = isObjectRecord(body.reasoning) ? body.reasoning : {};
    const hasExplicitEffort = hasOwn(reasoning, "effort");
    const hasLegacyEffort = hasOwn(body, "reasoning_effort");
    const requestedEffort = hasExplicitEffort
      ? reasoning.effort
      : hasLegacyEffort
        ? body.reasoning_effort
        : requested.hasEffort
          ? requested.effort
          : "low";
    const effort = normalizeReasoningEffort(
      requestedEffort,
      supportedEfforts,
      requested.modelId,
    );
    body.reasoning = reasoning;
    body.reasoning.effort = effort;
    if (!hasOwn(body.reasoning, "summary")) body.reasoning.summary = "auto";
    delete body.reasoning_effort;

    // Mode and effort are independent axes. An explicit client mode wins over
    // virtual-alias metadata; Standard remains the upstream default when omitted.
    const hasExplicitMode = hasOwn(body.reasoning, "mode");
    const requestedMode = hasExplicitMode ? body.reasoning.mode : aliasMode;
    const mode = normalizeReasoningMode(
      requestedMode,
      supportedModes,
      requested.modelId,
      hasExplicitMode || aliasMode != null,
    );
    if (mode) body.reasoning.mode = mode;
    else delete body.reasoning.mode;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens; // Responses API clients send this but Codex rejects it
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // store=false → backend can't resolve previous resp; avoid 404

    if (body.service_tier === "fast") body.service_tier = "priority";
    if (body.service_tier && body.service_tier !== "priority") delete body.service_tier;

    // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }
}
