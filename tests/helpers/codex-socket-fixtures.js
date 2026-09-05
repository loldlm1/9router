import { createServer, request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";

export async function listenLoopback(handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server, sockets,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function listenConnectProxy(allowedOrigins) {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).host));
  const proxy = await listenLoopback((_req, res) => { res.writeHead(405); res.end(); });
  proxy.tunnels = 0;
  proxy.server.on("connect", (req, socket, head) => {
    if (!allowed.has(req.url)) { socket.destroy(); return; }
    proxy.tunnels++;
    const target = new URL(`http://${req.url}`);
    const upstream = connect({ host: "127.0.0.1", port: Number(target.port) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  return proxy;
}

export async function listenForwardingProxy(origin, { buffering = false, idleMs = 0, durationMs = 0 } = {}) {
  const target = new URL(origin);
  return listenLoopback((req, res) => {
    let idleTimer;
    let durationTimer;
    const upstream = request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers });
    const stop = () => { upstream.destroy(); res.destroy(); };
    const armIdle = () => {
      clearTimeout(idleTimer);
      if (idleMs) idleTimer = setTimeout(stop, idleMs);
    };
    upstream.on("error", () => res.destroy());
    upstream.on("response", (response) => {
      res.writeHead(response.statusCode, response.headers);
      res.flushHeaders();
      const chunks = [];
      response.on("data", (chunk) => {
        armIdle();
        if (buffering) chunks.push(chunk);
      });
      response.on("error", stop);
      if (buffering) response.on("end", () => res.end(Buffer.concat(chunks)));
      else response.pipe(res);
    });
    res.on("close", () => {
      clearTimeout(idleTimer);
      clearTimeout(durationTimer);
      upstream.destroy();
    });
    armIdle();
    if (durationMs) durationTimer = setTimeout(stop, durationMs);
    req.pipe(upstream);
  });
}
