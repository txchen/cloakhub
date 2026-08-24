import { createServer, request as requestHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { request as requestHttps } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";

export interface BrowserProxySession {
  browserUrl: string;
  close(): Promise<void>;
}

export interface BrowserProxyRuntime {
  prepare(proxyUrl: string): Promise<BrowserProxySession>;
}

export function createBrowserProxyRuntime(): BrowserProxyRuntime {
  return {
    async prepare(proxyUrl: string): Promise<BrowserProxySession> {
      if (!proxyUrl) {
        return directProxySession("");
      }

      const upstream = new URL(proxyUrl);
      const hasCredentials = upstream.username !== "" || upstream.password !== "";
      if (!hasCredentials || upstream.protocol === "socks5:") {
        return directProxySession(proxyUrl);
      }

      return startAuthenticatedHttpRelay(upstream);
    }
  };
}

function directProxySession(browserUrl: string): BrowserProxySession {
  return {
    browserUrl,
    close: async () => undefined
  };
}

async function startAuthenticatedHttpRelay(upstream: URL): Promise<BrowserProxySession> {
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`Unsupported authenticated proxy protocol: ${upstream.protocol}`);
  }

  const authorization = basicProxyAuthorization(upstream);
  const sockets = new Set<Duplex>();
  const server = createServer((request, response) => {
    forwardHttpRequest(upstream, authorization, request, response);
  });

  server.on("connection", (socket) => trackSocket(sockets, socket));
  server.on("connect", (request, clientSocket, head) => {
    forwardConnectRequest(upstream, authorization, request, clientSocket, head, sockets);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server, sockets);
    throw new Error("Authenticated proxy relay did not allocate a TCP port");
  }

  let closePromise: Promise<void> | undefined;
  return {
    browserUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      closePromise ??= closeServer(server, sockets);
      await closePromise;
    }
  };
}

function forwardHttpRequest(
  upstream: URL,
  authorization: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse
): void {
  const request = (upstream.protocol === "https:" ? requestHttps : requestHttp)(
    {
      headers: {
        ...incoming.headers,
        "proxy-authorization": authorization
      },
      hostname: upstream.hostname,
      method: incoming.method,
      path: incoming.url,
      port: Number(upstream.port)
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(outgoing);
    }
  );

  request.on("error", () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502);
    }
    outgoing.end();
  });
  outgoing.once("close", () => request.destroy());
  incoming.pipe(request);
}

function forwardConnectRequest(
  upstream: URL,
  authorization: string,
  incoming: IncomingMessage,
  clientSocket: Duplex,
  clientHead: Buffer,
  sockets: Set<Duplex>
): void {
  let tunnelEstablished = false;
  const onConnected = (upstreamSocket: Socket): void => {
    upstreamSocket.write(
      `CONNECT ${incoming.url ?? ""} HTTP/1.1\r\n` +
        `Host: ${incoming.url ?? ""}\r\n` +
        `Proxy-Authorization: ${authorization}\r\n` +
        "Proxy-Connection: Keep-Alive\r\n\r\n"
    );

    readConnectResponse(upstreamSocket, (responseHead, remaining, successful) => {
      clientSocket.write(responseHead);
      if (!successful) {
        clientSocket.end();
        upstreamSocket.end();
        return;
      }

      tunnelEstablished = true;
      if (remaining.length > 0) {
        clientSocket.write(remaining);
      }
      if (clientHead.length > 0) {
        upstreamSocket.write(clientHead);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
  };

  const upstreamSocket =
    upstream.protocol === "https:"
      ? connectTls(
          {
            host: upstream.hostname,
            port: Number(upstream.port),
            servername: upstream.hostname
          },
          () => onConnected(upstreamSocket)
        )
      : connectTcp(Number(upstream.port), upstream.hostname, () => onConnected(upstreamSocket));

  trackSocket(sockets, upstreamSocket);
  clientSocket.once("close", () => upstreamSocket.destroy());
  upstreamSocket.once("error", () => {
    if (!clientSocket.destroyed) {
      if (tunnelEstablished) {
        clientSocket.destroy();
      } else {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    }
  });
}

function readConnectResponse(
  socket: Socket,
  complete: (responseHead: Buffer, remaining: Buffer, successful: boolean) => void
): void {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (buffered.length > 64 * 1024) {
        socket.destroy();
      }
      return;
    }

    socket.off("data", onData);
    const responseHead = buffered.subarray(0, headerEnd + 4);
    const statusLine = responseHead.toString("latin1", 0, responseHead.indexOf("\r\n"));
    complete(responseHead, buffered.subarray(headerEnd + 4), /^HTTP\/1\.[01] 2\d\d(?: |$)/.test(statusLine));
  };

  socket.on("data", onData);
}

function basicProxyAuthorization(upstream: URL): string {
  const username = decodeURIComponent(upstream.username);
  const password = decodeURIComponent(upstream.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

async function closeServer(server: ReturnType<typeof createServer>, sockets: Set<Duplex>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
