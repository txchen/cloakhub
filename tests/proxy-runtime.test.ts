import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { connect } from "node:net";

import { createBrowserProxyRuntime } from "../src/proxy-runtime";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

describe("BrowserProxyRuntime", () => {
  test("passes proxies without HTTP credentials directly to CloakBrowser", async () => {
    const runtime = createBrowserProxyRuntime();

    await expect(runtime.prepare("http://proxy.example:8080")).resolves.toMatchObject({
      browserUrl: "http://proxy.example:8080"
    });
    await expect(runtime.prepare("socks5://user:secret@proxy.example:1080")).resolves.toMatchObject({
      browserUrl: "socks5://user:secret@proxy.example:1080"
    });
  });

  test("relays HTTP requests through an authenticated upstream without exposing credentials to the browser", async () => {
    let receivedAuthorization: string | undefined;
    let receivedUrl: string | undefined;
    const upstream = createServer((incoming, outgoing) => {
      receivedAuthorization = incoming.headers["proxy-authorization"];
      receivedUrl = incoming.url;
      outgoing.end("proxied response");
    });
    const upstreamPort = await listen(upstream);
    cleanupTasks.push(() => close(upstream));

    const session = await createBrowserProxyRuntime().prepare(
      `http://proxy-user:proxy-secret@127.0.0.1:${upstreamPort}`
    );
    cleanupTasks.push(() => session.close());

    expect(session.browserUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.browserUrl).not.toContain("proxy-secret");
    const responseBody = await requestThroughProxy(session.browserUrl, "http://example.test/ip");

    expect(responseBody).toBe("proxied response");
    expect(receivedUrl).toBe("http://example.test:80/ip");
    expect(receivedAuthorization).toBe(
      `Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`
    );
  });

  test("relays CONNECT tunnels through an authenticated upstream", async () => {
    let receivedAuthorization: string | undefined;
    let receivedTarget: string | undefined;
    const upstream = createServer();
    upstream.on("connect", (incoming, socket) => {
      receivedAuthorization = incoming.headers["proxy-authorization"];
      receivedTarget = incoming.url;
      socket.end("HTTP/1.1 200 Connection Established\r\n\r\ntunnel-ready");
    });
    const upstreamPort = await listen(upstream);
    cleanupTasks.push(() => close(upstream));

    const session = await createBrowserProxyRuntime().prepare(
      `http://proxy-user:proxy-secret@127.0.0.1:${upstreamPort}`
    );
    cleanupTasks.push(() => session.close());

    const response = await connectThroughProxy(session.browserUrl, "secure.example:443");

    expect(response).toContain("HTTP/1.1 200 Connection Established");
    expect(response).toContain("tunnel-ready");
    expect(receivedTarget).toBe("secure.example:443");
    expect(receivedAuthorization).toBe(
      `Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`
    );
  });
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not allocate a TCP port");
  }
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestThroughProxy(proxyUrl: string, targetUrl: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise<string>((resolve, reject) => {
    const outgoing = request(
      {
        headers: { host: new URL(targetUrl).host },
        host: proxy.hostname,
        path: targetUrl,
        port: Number(proxy.port)
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolve(Buffer.concat(chunks).toString()));
      }
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function connectThroughProxy(proxyUrl: string, target: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname);
    const chunks: Buffer[] = [];
    cleanupTasks.push(async () => {
      socket.destroy();
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}
