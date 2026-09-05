const encoder = new TextEncoder();

export function sseEvent(type, fields = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function controlledStream() {
  let controller;
  const cancelled = deferred();
  const stream = new ReadableStream({
    start(value) { controller = value; },
    cancel(reason) { cancelled.resolve(reason); },
  });
  return {
    stream,
    cancelled: cancelled.promise,
    write(value) { controller.enqueue(typeof value === "string" ? encoder.encode(value) : value); },
    close() { controller.close(); },
    error(error) { controller.error(error); },
  };
}

export function socketError() {
  return new TypeError("terminated", { cause: Object.assign(new Error("synthetic socket close"), { code: "UND_ERR_SOCKET" }) });
}

export async function readText(stream) {
  return new Response(stream).text();
}
