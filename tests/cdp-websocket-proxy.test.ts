import { describe, expect, test } from "bun:test";

import {
  createCdpWebSocketHandler,
  type CdpBrowserSocket,
  type CdpSessionObserver,
  type CdpWebSocketData,
  type CdpWebSocketFactory
} from "../src/cdp-websocket-proxy";

describe("CdpWebSocketProxy", () => {
  test("relays client and browser websocket messages", async () => {
    const browser = fakeBrowserSocket();
    const sessions = fakeCdpSessions();
    const factory: CdpWebSocketFactory = {
      connect: () => browser
    };
    const handler = createCdpWebSocketHandler({ cdpSessions: sessions, factory });
    const client = fakeServerWebSocket({
      profileId: "work",
      targetUrl: "ws://127.0.0.1:5100/devtools/page/1"
    });

    await handler.open?.(client);
    await handler.message(client, "queued-before-open");
    browser.open();
    await handler.message(client, JSON.stringify({ id: 1, method: "Runtime.enable" }));
    browser.receive(JSON.stringify({ id: 1, result: {} }));

    expect(browser.sent).toEqual(["queued-before-open", JSON.stringify({ id: 1, method: "Runtime.enable" })]);
    expect(client.sent).toEqual([JSON.stringify({ id: 1, result: {} })]);
    expect(sessions.events).toEqual(["open:work", "message", "message"]);
  });

  test("closes the browser websocket when the client closes", async () => {
    const browser = fakeBrowserSocket();
    const sessions = fakeCdpSessions();
    const handler = createCdpWebSocketHandler({ cdpSessions: sessions, factory: { connect: () => browser } });
    const client = fakeServerWebSocket({
      profileId: "work",
      targetUrl: "ws://127.0.0.1:5100/devtools/page/1"
    });

    await handler.open?.(client);
    await handler.close?.(client, 1000, "done");

    expect(browser.closed).toBe(true);
    expect(sessions.events).toEqual(["open:work", "close"]);
  });
});

function fakeCdpSessions(): CdpSessionObserver & { events: string[] } {
  const events: string[] = [];

  return {
    events,
    openCdpSession: (profileId) => {
      events.push(`open:${profileId}`);
      return {
        close: () => {
          events.push("close");
        },
        recordMessage: () => {
          events.push("message");
        }
      };
    }
  };
}

function fakeBrowserSocket(): CdpBrowserSocket & {
  closed: boolean;
  open(): void;
  receive(data: string): void;
  sent: Array<string | Bun.BufferSource>;
} {
  return {
    closed: false,
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    readyState: WebSocket.CONNECTING,
    sent: [],
    close() {
      this.closed = true;
      this.readyState = WebSocket.CLOSED;
    },
    receive(data: string) {
      this.onmessage?.({ data });
    },
    open() {
      this.readyState = WebSocket.OPEN;
      this.onopen?.();
    },
    send(data: string | Bun.BufferSource) {
      this.sent.push(data);
    }
  };
}

function fakeServerWebSocket(data: CdpWebSocketData): Bun.ServerWebSocket<CdpWebSocketData> & {
  sent: Array<string | Bun.BufferSource>;
} {
  const socket = {
    binaryType: "nodebuffer",
    close: () => undefined,
    cork(callback: (ws: Bun.ServerWebSocket<CdpWebSocketData>) => unknown) {
      return callback(socket);
    },
    data,
    getBufferedAmount: () => 0,
    isSubscribed: () => false,
    ping: () => 1,
    pong: () => 1,
    publish: () => 1,
    publishBinary: () => 1,
    publishText: () => 1,
    readyState: WebSocket.OPEN,
    remoteAddress: "127.0.0.1",
    send(data: string | Bun.BufferSource) {
      this.sent.push(data);
      return 1;
    },
    sendBinary(data: Bun.BufferSource) {
      this.sent.push(data);
      return 1;
    },
    sendText(data: string) {
      this.sent.push(data);
      return 1;
    },
    sent: [],
    subscribe: () => undefined,
    subscriptions: [],
    terminate: () => undefined,
    unsubscribe: () => undefined
  } as Bun.ServerWebSocket<CdpWebSocketData> & { sent: Array<string | Bun.BufferSource> };

  return socket;
}
