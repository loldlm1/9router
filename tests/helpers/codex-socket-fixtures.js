import { createServer } from "node:http";
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
