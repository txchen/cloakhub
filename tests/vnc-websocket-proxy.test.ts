import { describe, expect, test } from "bun:test";

import {
  createVncWebSocketHandler,
  type VncSocket,
  type VncSocketFactory,
  type VncWebSocketData
} from "../src/vnc-websocket-proxy";

describe("VncWebSocketProxy", () => {
  test("relays VNC websocket traffic and tracks manual viewer presence", () => {
    const factory = fakeVncSocketFactory();
    const manualViewers = fakeManualViewers();
    const handler = createVncWebSocketHandler({ factory, manualViewers });
    const ws = fakeServerWebSocket({
      profileId: "work",
      targetHost: "127.0.0.1",
      targetPort: 5900
    });

    handler.open?.(ws);
    handler.message?.(ws, Buffer.from([1, 2, 3]));
    factory.sockets[0]?.ondata?.(Buffer.from([4, 5, 6]));
    handler.close?.(ws, 1000, "done");

    expect(factory.connections).toEqual([{ host: "127.0.0.1", port: 5900 }]);
    expect(factory.sockets[0]?.writes).toEqual([Buffer.from([1, 2, 3])]);
    expect(ws.sent).toEqual([Buffer.from([4, 5, 6])]);
    expect(manualViewers.events).toEqual(["open:work", "close:work"]);
    expect(factory.sockets[0]?.closed).toBe(true);
  });
});

function fakeVncSocketFactory(): VncSocketFactory & {
  connections: Array<{ host: string; port: number }>;
  sockets: Array<VncSocket & { closed: boolean; writes: Buffer[] }>;
} {
  const connections: Array<{ host: string; port: number }> = [];
  const sockets: Array<VncSocket & { closed: boolean; writes: Buffer[] }> = [];

  return {
    connections,
    sockets,
    connect: (host, port) => {
      connections.push({ host, port });
      const socket = {
        closed: false,
        writes: [] as Buffer[],
        close() {
          this.closed = true;
        },
        onclose: null,
        ondata: null,
        onerror: null,
        write(data: Buffer) {
          this.writes.push(data);
        }
      };
      sockets.push(socket);
      return socket;
    }
  };
}

function fakeManualViewers(): {
  events: string[];
  openManualViewerSession(profileId: string): { close(): void; recordInput(): void };
} {
  const events: string[] = [];

  return {
    events,
    openManualViewerSession(profileId) {
      events.push(`open:${profileId}`);
      return {
        close: () => events.push(`close:${profileId}`),
        recordInput: () => events.push(`input:${profileId}`)
      };
    }
  };
}

function fakeServerWebSocket(data: VncWebSocketData): Bun.ServerWebSocket<VncWebSocketData> & {
  sent: Buffer[];
} {
  const sent: Buffer[] = [];

  return {
    data,
    sent,
    close: () => undefined,
    send: (message: Buffer) => {
      sent.push(message);
      return true;
    }
  } as unknown as Bun.ServerWebSocket<VncWebSocketData> & { sent: Buffer[] };
}
