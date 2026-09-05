export const CODEX_CLIENT_VERSION = "0.153.0";
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`;
export const CODEX_ASTRA_MODEL_ID = "gpt-6-astra";

export const CODEX_STREAM_DIAGNOSTICS = Object.freeze({
  maxCauseDepth: 4,
  phases: ["dispatch", "headers", "preflight", "streaming"],
  outcomes: ["accepted", "retry", "eof", "completed", "failed", "incomplete", "cancelled"],
  terminalEvents: ["response.completed", "response.done", "response.failed", "response.incomplete", "error"],
  errorNames: ["Error", "TypeError", "AbortError", "TimeoutError"],
  errorCodes: ["UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EPIPE", "STREAM_STALL_TIMEOUT", "STREAM_PROTOCOL_ERROR", "CLIENT_CANCELLED"],
});

export function isCodexAstraModel(modelId) {
  if (typeof modelId !== "string") return false;
  return modelId === CODEX_ASTRA_MODEL_ID
    || modelId.startsWith(`${CODEX_ASTRA_MODEL_ID}-`)
    || modelId.startsWith(`${CODEX_ASTRA_MODEL_ID}(`);
}

export function getCodexAstraRouteId(modelId) {
  if (!isCodexAstraModel(modelId)) return modelId;
  const clean = modelId.replace(/\([^()]*\)\s*$/, "");
  for (const routeId of [
    `${CODEX_ASTRA_MODEL_ID}-review`,
    `${CODEX_ASTRA_MODEL_ID}-pro`,
    CODEX_ASTRA_MODEL_ID,
  ]) {
    if (clean === routeId || clean.startsWith(`${routeId}-`)) return routeId;
  }
  return clean;
}
