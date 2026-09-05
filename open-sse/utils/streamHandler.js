// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, onComplete, log, provider, model, reqTag = "", diagnostics = null, requestSignal } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  const notify = (callback, value) => {
    try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* cleanup is best effort */ }
  };
  const detach = () => requestSignal?.removeEventListener("abort", onAbort);
  const controller = {
    signal: abortController.signal,
    startTime,
    diagnostics,
    isConnected: () => !disconnected,
    handleDisconnect(reason = "client_closed") {
      if (disconnected) return;
      disconnected = true;
      detach();
      diagnostics?.finish("cancelled", Object.assign(new Error(), { code: "CLIENT_CANCELLED" }));
      abortController.abort(new DOMException("Client disconnected", "AbortError"));
      notify(onDisconnect, { reason, duration: Date.now() - startTime });
    },
    handleComplete(outcome = "eof") {
      if (disconnected) return;
      disconnected = true;
      detach();
      diagnostics?.finish(outcome);
      notify(onComplete, outcome);
    },
    handleError(error) {
      if (disconnected) return;
      disconnected = true;
      detach();
      diagnostics?.finish(error?.name === "AbortError" ? "cancelled" : "failed", error);
      if (!diagnostics) {
        const status = error?.name === "AbortError" ? "ABORTED" : `ERROR: ${error?.message}${error?.stack ? `\n    ${error.stack}` : ""}`;
        if (log?.errorLine) log.errorLine(reqTag, "!", `${status} | ${provider}/${model} | ${Date.now() - startTime}ms`);
        else console.log(`[${getTimeString()}] ${provider}/${model} | ${status}`);
      }
      notify(onError, error);
    },
    abort: (reason) => abortController.abort(reason),
  };
  const onAbort = () => controller.handleDisconnect("request_aborted");
  if (requestSignal?.aborted) onAbort();
  else requestSignal?.addEventListener("abort", onAbort, { once: true });
  return controller;
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null, responsesLifecycle = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  let cancelled = false;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= Promise.allSettled([reader.cancel(), writer.abort()]).then(() => {
    reader.releaseLock();
    writer.releaseLock?.();
  });
  const forward = (controller, bytes) => {
    controller.enqueue(bytes);
    streamController.diagnostics?.downstream(bytes);
    return responsesLifecycle?.forwarded(bytes);
  };
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    const bytes = onAbortTerminal();
    if (bytes) forward(controller, bytes);
  };
  const settle = (outcome, error) => responsesLifecycle?.settle(outcome, error || responsesLifecycle?.protocolError);

  return new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      if (!streamController.isConnected()) {
        emitTerminal(controller);
        settle("failed");
        controller.close();
        await cleanup();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          if (responsesLifecycle && !responsesLifecycle.deliveredTerminal) emitTerminal(controller);
          const outcome = responsesLifecycle?.deliveredTerminal || (responsesLifecycle ? "failed" : "eof");
          settle(outcome);
          streamController.handleComplete(outcome);
          controller.close();
          await cleanup();
          return;
        }
        const outcome = forward(controller, value);
        if (outcome) {
          settle(outcome);
          if (responsesLifecycle?.protocolError) streamController.handleError(responsesLifecycle.protocolError);
          else streamController.handleComplete(outcome);
          controller.close();
          await cleanup();
        }
      } catch (error) {
        if (cancelled) return;
        const wasConnected = streamController.isConnected();
        streamController.handleError(error);
        const message = error?.message || "";
        const code = error?.code || error?.cause?.code;
        const networkClose = error?.name === "AbortError" || /aborted|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE/.test(message)
          || ["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"].includes(code);
        try {
          if (!wasConnected || networkClose || onAbortTerminal) {
            emitTerminal(controller);
            settle("failed", error);
            controller.close();
          } else controller.error(error);
        } finally { await cleanup(); }
      }
    },
    async cancel(reason) {
      cancelled = true;
      settle("cancelled");
      streamController.handleDisconnect(reason || "cancelled");
      await cleanup();
    },
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS, responsesLifecycle = null) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(Object.assign(new Error("stream stall timeout"), { code: "STREAM_STALL_TIMEOUT" }));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    diagnostics: streamController.diagnostics,
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: (outcome) => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(outcome); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleDisconnect(r); },
    abort: () => { clearStall(); streamController.abort(); }
  };

  armStall();
  streamController.diagnostics?.phase("streaming");
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap, { signal: streamController.signal })
    .pipeThrough(transformStream, { signal: streamController.signal });

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal,
    responsesLifecycle
  );
}
