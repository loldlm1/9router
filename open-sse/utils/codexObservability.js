import { FALLBACK_SCOPE_ACCOUNT, normalizeFallbackScope } from "../services/fallbackScope.js";
import { CODEX_STREAM_DIAGNOSTICS, getCodexAstraRouteId, isCodexAstraModel } from "../config/codexConstants.js";
import { randomUUID } from "node:crypto";

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const ASTRA_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const REASONING_MODES = new Set(["standard", "pro"]);

function safeModelId(value) {
  if (typeof value !== "string" || !value) return "unknown";
  return value.replace(/[^a-zA-Z0-9._:/()-]/g, "?").slice(0, 128) || "unknown";
}

function safeReasoningValue(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function getAstraSuffixEffort(modelId) {
  if (!isCodexAstraModel(modelId)) return null;
  const parenthesized = modelId.match(/\(([^()]*)\)\s*$/);
  if (parenthesized) return parenthesized[1];

  const routeId = getCodexAstraRouteId(modelId);
  if (modelId === routeId || !modelId.startsWith(`${routeId}-`)) return null;
  return modelId.slice(routeId.length + 1);
}

/**
 * Build a bounded, prompt-free Codex routing trace. Only model routing,
 * reasoning selection, endpoint class, status, and fallback scope are read.
 */
export function formatCodexDecisionLog({
  requestedModel,
  upstreamModel,
  requestBody,
  upstreamBody,
  aliasMode,
  compact = false,
  status,
  fallbackScope = FALLBACK_SCOPE_ACCOUNT,
}) {
  const requestedReasoning = requestBody?.reasoning && typeof requestBody.reasoning === "object"
    ? requestBody.reasoning
    : {};
  const effectiveReasoning = upstreamBody?.reasoning && typeof upstreamBody.reasoning === "object"
    ? upstreamBody.reasoning
    : {};
  const hasRequestedMode = hasOwn(requestedReasoning, "mode") || aliasMode != null;
  const rawRequestedMode = hasOwn(requestedReasoning, "mode")
    ? requestedReasoning.mode
    : aliasMode;
  const suffixEffort = getAstraSuffixEffort(requestedModel);
  const hasRequestedEffort =
    hasOwn(requestedReasoning, "effort") ||
    hasOwn(requestBody || {}, "reasoning_effort") ||
    suffixEffort != null;
  const rawRequestedEffort = hasOwn(requestedReasoning, "effort")
    ? requestedReasoning.effort
    : hasOwn(requestBody || {}, "reasoning_effort")
      ? requestBody.reasoning_effort
      : suffixEffort;
  const requestedMode = safeReasoningValue(rawRequestedMode, REASONING_MODES, hasRequestedMode ? "invalid" : "standard");
  const effectiveMode = safeReasoningValue(effectiveReasoning.mode, REASONING_MODES, "standard");
  const requestedEffortSet = isCodexAstraModel(requestedModel)
    ? ASTRA_REASONING_EFFORTS
    : REASONING_EFFORTS;
  const effectiveEffortSet = isCodexAstraModel(upstreamBody?.model || upstreamModel)
    ? ASTRA_REASONING_EFFORTS
    : REASONING_EFFORTS;
  const requestedEffort = safeReasoningValue(
    rawRequestedEffort,
    requestedEffortSet,
    hasRequestedEffort ? "invalid" : "default",
  );
  const effectiveEffort = safeReasoningValue(effectiveReasoning.effort, effectiveEffortSet, "unknown");
  const numericStatus = Number(status);
  const safeStatus = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? String(numericStatus)
    : "error";

  return [
    `requested_model=${safeModelId(requestedModel)}`,
    `upstream_model=${safeModelId(upstreamBody?.model || upstreamModel)}`,
    `requested_mode=${requestedMode}`,
    `effective_mode=${effectiveMode}`,
    `requested_effort=${requestedEffort}`,
    `effective_effort=${effectiveEffort}`,
    `endpoint=${compact ? "compact" : "responses"}`,
    `status=${safeStatus}`,
    `fallback_scope=${normalizeFallbackScope(fallbackScope)}`,
  ].join(" · ");
}

export function classifyCodexStreamError(error) {
  const errorName = CODEX_STREAM_DIAGNOSTICS.errorNames.includes(error?.name) ? error.name : "Error";
  let errorCode = "unknown";
  let cause = error;
  for (let depth = 0; cause && depth < CODEX_STREAM_DIAGNOSTICS.maxCauseDepth; depth++) {
    if (CODEX_STREAM_DIAGNOSTICS.errorCodes.includes(cause.code)) {
      errorCode = cause.code;
      break;
    }
    cause = cause.cause;
  }
  return { error_name: errorName, error_code: errorCode };
}

// Only counters and allowlisted values enter this trace; never retain event payloads.
export function createCodexStreamDiagnostics({ log, now = Date.now } = {}) {
  const requestId = randomUUID();
  const requestStartedAt = now();
  let attempt = 0;
  let state;
  let ended = false;
  const reset = () => {
    state = {
      request_id: requestId, attempt, phase: "dispatch", upstream_http_status: null,
      headers_ms: null, preflight_ms: null, first_upstream_event_ms: null,
      last_upstream_read_ms: null, last_downstream_write_ms: null,
      upstream_bytes: 0, upstream_chunks: 0, downstream_bytes: 0, downstream_chunks: 0,
      events: 0, terminal_event: null,
    };
    ended = false;
  };
  reset();
  const elapsed = () => Math.max(0, now() - requestStartedAt);
  const snapshot = () => ({ ...state, elapsed_ms: elapsed() });
  const emit = (outcome, error) => {
    const record = { ...snapshot(), outcome, ...(error ? classifyCodexStreamError(error) : {}) };
    try {
      if (outcome === "failed" && log?.errorLine) log.errorLine("", "!", `CODEX_STREAM ${JSON.stringify(record)}`);
      else log?.info?.("CODEX_STREAM", JSON.stringify(record));
    } catch { /* logging cannot break a stream */ }
    return record;
  };
  const finish = (outcome, error) => {
    if (ended) return;
    ended = true;
    return emit(CODEX_STREAM_DIAGNOSTICS.outcomes.includes(outcome) ? outcome : "failed", error);
  };
  const countBytes = (value) => Number.isSafeInteger(value?.byteLength) ? value.byteLength : 0;
  return {
    requestId,
    snapshot,
    beginAttempt() {
      if (attempt && !ended) finish("retry");
      attempt++;
      reset();
    },
    phase(phase) {
      if (!CODEX_STREAM_DIAGNOSTICS.phases.includes(phase)) return;
      state.phase = phase;
      if (phase === "streaming") state.preflight_ms = state.headers_ms === null ? null : elapsed() - state.headers_ms;
    },
    headers(status) {
      state.phase = "headers";
      state.headers_ms = elapsed();
      state.upstream_http_status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      emit("accepted");
    },
    upstream(chunk) {
      state.last_upstream_read_ms = elapsed();
      state.upstream_bytes += countBytes(chunk);
      state.upstream_chunks++;
    },
    downstream(chunk) {
      state.last_downstream_write_ms = elapsed();
      state.downstream_bytes += countBytes(chunk);
      state.downstream_chunks++;
    },
    event(type) {
      state.first_upstream_event_ms ??= elapsed();
      state.events++;
      if (CODEX_STREAM_DIAGNOSTICS.terminalEvents.includes(type)) state.terminal_event = type;
    },
    finish,
  };
}
