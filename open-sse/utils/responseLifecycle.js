export function bindResponseLifecycle(response, onSettled, signal) {
  if (!(response instanceof Response)) {
    throw new TypeError("response must be a Response");
  }
  if (typeof onSettled !== "function") {
    throw new TypeError("onSettled must be a function");
  }

  let settled = false;
  let onAbort;
  const settle = () => {
    if (settled) return false;
    settled = true;
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    try {
      onSettled();
    } catch {
      // Lifecycle cleanup must not replace the response outcome.
    }
    return true;
  };

  if (!response.body) {
    settle();
    return response;
  }

  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    settle();
    throw error;
  }

  const body = new ReadableStream({
    start(controller) {
      onAbort = () => {
        if (!settle()) return;
        void reader.cancel(signal.reason).catch(() => {}).finally(() => reader.releaseLock());
        controller.close();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) {
          settle();
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (settled) return;
        settle();
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
        reader.releaseLock();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
