import { describe, expect, test } from "bun:test";

import {
  createKasmVncWebSocketFactory,
  createVncWebSocketHandler,
  type KasmVncClientWebSocket,
  type VncSocket,
  type VncSocketFactory,
  type VncWebSocketData
} from "../src/vnc-websocket-proxy";

describe("VncWebSocketProxy", () => {
  test("filters RFB traffic, translates clipboard frames, and tracks manual viewer presence", () => {
    const factory = fakeVncSocketFactory();
    const manualViewers = fakeManualViewers();
    const handler = createVncWebSocketHandler({ factory, manualViewers });
    const ws = fakeServerWebSocket({
      profileId: "work",
      targetHost: "127.0.0.1",
      targetPort: 5900
    });

    handler.open?.(ws);
    handler.message?.(ws, Buffer.from("RFB 003.008\n"));
    handler.message?.(ws, Buffer.from([1]));
    handler.message?.(ws, Buffer.from([1]));
    handler.message?.(ws, Buffer.concat([makeExtension150(), makePointerEvent()]));
    const clipboard = makeKasmVncClipboard("hello");
    factory.sockets[0]?.ondata?.(clipboard);
    handler.close?.(ws, 1000, "done");

    expect(factory.connections).toEqual([{ host: "127.0.0.1", port: 5900 }]);
    expect(factory.sockets[0]?.writes).toEqual([
      Buffer.from("RFB 003.008\n"),
      Buffer.from([1]),
      Buffer.from([1]),
      Buffer.concat([makeExtension150(), makeKasmPointerEvent()])
    ]);
    expect(ws.sent).toEqual([makeServerCutText("hello")]);
    expect(manualViewers.events).toEqual(["open:work", "input:work", "close:work"]);
    expect(factory.sockets[0]?.closed).toBe(true);
  });

  test("tracks multiple manual viewers on the same Browser Instance independently", () => {
    const factory = fakeVncSocketFactory();
    const manualViewers = fakeManualViewers();
    const handler = createVncWebSocketHandler({ factory, manualViewers });
    const first = fakeServerWebSocket({ profileId: "work", targetHost: "127.0.0.1", targetPort: 5900 });
    const second = fakeServerWebSocket({ profileId: "work", targetHost: "127.0.0.1", targetPort: 5900 });

    handler.open?.(first);
    handler.open?.(second);
    handler.close?.(first, 1000, "done");
    handler.close?.(second, 1000, "done");

    expect(factory.connections).toEqual([
      { host: "127.0.0.1", port: 5900 },
      { host: "127.0.0.1", port: 5900 }
    ]);
    expect(manualViewers.events).toEqual(["open:work", "open:work", "close:work", "close:work"]);
  });

  test("translates a server clipboard WebSocket message before sending it to the Manual Client", () => {
    const factory = fakeVncSocketFactory();
    const handler = createVncWebSocketHandler({ factory });
    const ws = fakeServerWebSocket({
      profileId: "work",
      targetHost: "127.0.0.1",
      targetPort: 5900
    });

    handler.open?.(ws);
    factory.sockets[0]?.ondata?.(Buffer.from([2]));
    factory.sockets[0]?.ondata?.(makeKasmVncClipboard("hello"));

    expect(ws.sent).toEqual([Buffer.from([2]), makeServerCutText("hello")]);
  });

  test("connects to KasmVNC websockify and queues writes until the upstream socket opens", () => {
    const clients: Array<KasmVncClientWebSocket & { sent: Buffer[]; url: string }> = [];
    const connectOptions: unknown[] = [];
    const factory = createKasmVncWebSocketFactory((url, options) => {
      connectOptions.push(options);
      const client: KasmVncClientWebSocket & { sent: Buffer[]; url: string } = {
        binaryType: "blob",
        close: () => undefined,
        onclose: null,
        onerror: null,
        onmessage: null,
        onopen: null,
        send(data) {
          this.sent.push(Buffer.from(data));
        },
        sent: [],
        url
      };
      clients.push(client);
      return client;
    });
    const socket = factory.connect("127.0.0.1", 5900);
    const received: Buffer[] = [];
    socket.ondata = (data) => received.push(data);

    socket.write(Buffer.from("RFB 003.008\n"));
    expect(clients[0]?.url).toBe("ws://127.0.0.1:5900/websockify");
    expect(connectOptions).toEqual([
      {
        headers: {
          Origin: "http://127.0.0.1:5900",
          "Sec-WebSocket-Origin": "http://127.0.0.1:5900"
        },
        protocols: ["binary"]
      }
    ]);
    expect(clients[0]?.sent).toEqual([]);

    clients[0]?.onopen?.();
    clients[0]?.onmessage?.({ data: Uint8Array.from([180, 0, 0]).buffer });

    expect(clients[0]?.binaryType).toBe("arraybuffer");
    expect(clients[0]?.sent).toEqual([Buffer.from("RFB 003.008\n")]);
    expect(received).toEqual([Buffer.from([180, 0, 0])]);
  });
});

function makePointerEvent(): Buffer {
  const buffer = Buffer.alloc(6);
  buffer[0] = 5;
  buffer[1] = 1;
  buffer.writeUInt16BE(100, 2);
  buffer.writeUInt16BE(200, 4);
  return buffer;
}

function makeKasmPointerEvent(): Buffer {
  const buffer = Buffer.alloc(11);
  buffer[0] = 5;
  buffer.writeUInt16BE(1, 1);
  buffer.writeUInt16BE(100, 3);
  buffer.writeUInt16BE(200, 5);
  return buffer;
}

function makeExtension150(): Buffer {
  const buffer = Buffer.alloc(10);
  buffer[0] = 150;
  buffer[1] = 1;
  buffer.writeUInt16BE(1920, 6);
  buffer.writeUInt16BE(1080, 8);
  return buffer;
}

function makeKasmVncClipboard(text: string): Buffer {
  const mime = Buffer.from("text/plain");
  const value = Buffer.from(text, "utf8");
  const header = Buffer.alloc(7 + mime.length + 4);
  header[0] = 180;
  header[6] = mime.length;
  mime.copy(header, 7);
  header.writeUInt32BE(value.length, 7 + mime.length);
  return Buffer.concat([header, value]);
}

function makeServerCutText(text: string): Buffer {
  const value = Buffer.from(text, "latin1");
  const buffer = Buffer.alloc(8 + value.length);
  buffer[0] = 3;
  buffer.writeUInt32BE(value.length, 4);
  value.copy(buffer, 8);
  return buffer;
}

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
