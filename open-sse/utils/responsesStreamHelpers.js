import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";
import { CODEX_STREAM_DIAGNOSTICS } from "../config/codexConstants.js";
import { RESPONSES_MAX_EVENT_BYTES } from "../config/runtimeConfig.js";
import { SSE_DONE } from "./sseConstants.js";

const encoder = new TextEncoder();

export function getOpenAIResponsesEventName(eventName, chunk) {
  return eventName || (typeof chunk?.type === "string" ? chunk.type : null);
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  return !!chunk && (CODEX_STREAM_DIAGNOSTICS.terminalEvents.includes(getOpenAIResponsesEventName(eventName, chunk))
    || ["completed", "failed", "incomplete"].includes(chunk.response?.status));
}

export function responsesProtocolError() {
  return Object.assign(new Error("Invalid or truncated Responses SSE event"), { code: "STREAM_PROTOCOL_ERROR" });
}

// Frame complete SSE events before forwarding, including CR/LF splits and multiline data.
export function createResponsesFrameDecoder(onFrame, maxBytes = RESPONSES_MAX_EVENT_BYTES) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let buffer = "";
  let lines = [];
  let pendingBytes = 0;
  let frameBytes = 0;
  let firstLine = true;
  let stopped = false;

  const drain = (eof = false) => {
    while (!stopped) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (!eof && buffer[index] === "\r" && index === buffer.length - 1)) break;
      const newline = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      let line = buffer.slice(0, index);
      frameBytes += encoder.encode(line).byteLength + newline;
      if (frameBytes > maxBytes) throw responsesProtocolError();
      buffer = buffer.slice(index + newline);
      if (firstLine) { line = line.replace(/^\uFEFF/, ""); firstLine = false; }
      if (line) { lines.push(line); continue; }
      const raw = `${lines.join("\n")}\n\n`;
      let event = null;
      const data = [];
      for (const item of lines) {
        const colon = item.indexOf(":");
        const name = colon < 0 ? item : item.slice(0, colon);
        const value = colon < 0 ? "" : item.slice(colon + 1).replace(/^ /, "");
        if (name === "event") event = value;
        if (name === "data") data.push(value);
      }
      const text = data.join("\n");
      const done = text === "[DONE]";
      let parsed = null;
      if (data.length && !done) {
        try { parsed = JSON.parse(text); } catch { throw responsesProtocolError(); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw responsesProtocolError();
        if (event && parsed.type && event !== parsed.type) throw responsesProtocolError();
      }
      pendingBytes -= frameBytes;
      frameBytes = 0;
      lines = [];
      stopped = onFrame({ raw, event: getOpenAIResponsesEventName(event, parsed), data: parsed, done }) === false;
    }
    if (!stopped && pendingBytes > maxBytes) throw responsesProtocolError();
  };

  return {
    push(chunk) {
      if (stopped) return;
      pendingBytes += chunk.byteLength;
      try { buffer += decoder.decode(chunk, { stream: true }); } catch { throw responsesProtocolError(); }
      drain();
    },
    finish() {
      if (stopped) return;
      try { buffer += decoder.decode(); } catch { throw responsesProtocolError(); }
      drain(true);
      if (buffer || lines.length) throw responsesProtocolError();
    },
  };
}

function terminalOutcome(type, data) {
  if (!isOpenAIResponsesTerminalEvent(type, data)) return null;
  if (type === "error") return "failed";
  const status = data?.response?.status;
  if (!data.response?.id || (status && !["completed", "failed", "incomplete"].includes(status))) throw responsesProtocolError();
  if (type !== "response.done" && status && type !== `response.${status}`) throw responsesProtocolError();
  if (["completed", "failed", "incomplete"].includes(status)) return status;
  if (type === "response.completed" || type === "response.done") return "completed";
  return type === "response.incomplete" ? "incomplete" : "failed";
}

export function createResponsesStreamLifecycle() {
  const frames = new WeakMap();
  return {
    responseId: null,
    sequence: -1,
    parsedTerminal: null,
    deliveredTerminal: null,
    settled: false,
    onSettle: null,
    frame(bytes, type, data) {
      const id = data?.response?.id;
      if (typeof id === "string") {
        if (this.responseId && this.responseId !== id) throw responsesProtocolError();
        this.responseId = id;
      }
      if (data?.sequence_number !== undefined) {
        if (!Number.isSafeInteger(data.sequence_number) || data.sequence_number < 0 || data.sequence_number <= this.sequence) throw responsesProtocolError();
        this.sequence = data.sequence_number;
      }
      const outcome = terminalOutcome(type, data);
      if (outcome) this.parsedTerminal = outcome;
      frames.set(bytes, outcome);
      return bytes;
    },
    forwarded(bytes) {
      const outcome = frames.get(bytes);
      if (outcome && !this.deliveredTerminal) this.deliveredTerminal = outcome;
      return outcome;
    },
    failureBytes() {
      if (this.deliveredTerminal) return null;
      const bytes = buildAbortedResponsesTerminalBytes(this);
      frames.set(bytes, "failed");
      this.parsedTerminal = "failed";
      return bytes;
    },
    settle(outcome, error) {
      if (this.settled) return;
      this.settled = true;
      try { this.onSettle?.({ outcome: this.deliveredTerminal || outcome, error }); } catch { /* settlement is final */ }
    },
  };
}

export function buildAbortedResponsesTerminalBytes(state = {}) {
  return encoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure(state)}${SSE_DONE}`);
}

export function formatIncompleteOpenAIResponsesStreamFailure({ responseId, sequence = -1 } = {}) {
  const error = { type: "stream_error", code: "stream_disconnected", message: "stream closed before response.completed" };
  const event = responseId ? "response.failed" : "error";
  const data = responseId
    ? { type: event, sequence_number: sequence + 1, response: { id: responseId, status: "failed", error } }
    : { type: event, sequence_number: sequence + 1, code: error.code, message: error.message, param: null };
  return formatSSE({ event, data }, FORMATS.OPENAI_RESPONSES);
}
