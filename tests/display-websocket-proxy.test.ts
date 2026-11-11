import { describe, expect, test } from "bun:test";

import {
  classifyClientMessage,
  createDisplayWebSocketHandler,
  shouldForwardServerMessage,
  type DisplayUpstream,
  type DisplayWebSocketData
} from "../src/display-websocket-proxy";

describe("display websocket proxy", () => {
  test("counts pointer, wheel, key and clipboard commands as Manual Input", () => {
    for (const command of ["m,10,20", "b,0,1", "sp,0.0,-120.0", "k,65,1", "c,hello"]) {
      expect(classifyClientMessage(command, true)).toEqual({ forward: true, manualInput: true });
    }
    for (const command of ["a,12", "v,1", "kf", "po,123", "r"]) {
      expect(classifyClientMessage(command, true)).toEqual({ forward: true, manualInput: false });
    }
  });

  test("drops microphone, resize and disabled clipboard traffic", () => {
    expect(classifyClientMessage("mi,1", true).forward).toBe(false);
    expect(classifyClientMessage("sz,800,600", true).forward).toBe(false);
    expect(classifyClientMessage(Buffer.from([0x12, 1, 2]), true).forward).toBe(false);
    expect(classifyClientMessage("c,secret", false)).toEqual({ forward: false, manualInput: false });
    expect(classifyClientMessage(Buffer.from([0x11, 0x89]), false).forward).toBe(false);
    expect(classifyClientMessage(Buffer.from([0x11, 0x89]), true)).toEqual({ forward: true, manualInput: true });
  });

  test("filters desktop clipboard updates only when clipboard sync is off", () => {
    const clip = '{"d":"secret","t":"clip"}';
    const image = Buffer.from([0x04, 0x89]);
    const video = Buffer.from([0x01, 0, 0]);
    expect(shouldForwardServerMessage(clip, true)).toBe(true);
    expect(shouldForwardServerMessage(clip, false)).toBe(false);
    expect(shouldForwardServerMessage(image, false)).toBe(false);
    expect(shouldForwardServerMessage(video, false)).toBe(true);
    expect(shouldForwardServerMessage('{"t":"hello","w":1,"h":1}', false)).toBe(true);
  });

  test("relays text and binary frames both ways and records Manual Input", () => {
    const upstreamSent: (string | Buffer)[] = [];
    let upstream: DisplayUpstream | undefined;
    let inputs = 0;
    let closed = 0;
    const handler = createDisplayWebSocketHandler({
      clipboardSyncEnabled: () => true,
      factory: {
        connect(host, port) {
          expect([host, port]).toEqual(["127.0.0.1", 5900]);
          upstream = {
            close: () => undefined,
            onclose: null,
            onerror: null,
            onmessage: null,
            send: (data) => upstreamSent.push(data)
          };
          return upstream;
        }
      },
      manualViewers: {
        openManualViewerSession: () => ({
          close: () => {
            closed += 1;
          },
          recordInput: () => {
            inputs += 1;
          }
        })
      }
    });
    const clientSent: (string | Buffer)[] = [];
    const ws = {
      close: () => undefined,
      data: { kind: "display", profileId: "work", targetHost: "127.0.0.1", targetPort: 5900 } as DisplayWebSocketData,
      getBufferedAmount: () => 0,
      send: (data: string | Buffer) => {
        clientSent.push(data);
        return 1;
      }
    } as unknown as Bun.ServerWebSocket<DisplayWebSocketData>;

    handler.open?.(ws);
    handler.message?.(ws, "k,65,1");
    handler.message?.(ws, "a,1");
    handler.message?.(ws, Buffer.from([0x11, 1]));
    upstream!.onmessage?.('{"t":"hello","w":1,"h":1}');
    upstream!.onmessage?.(Buffer.from([0x01, 2, 3]));
    handler.close?.(ws, 1000, "");

    expect(upstreamSent[0]).toBe("k,65,1");
    expect(upstreamSent[1]).toBe("a,1");
    expect(Buffer.isBuffer(upstreamSent[2])).toBe(true);
    expect(clientSent[0]).toBe('{"t":"hello","w":1,"h":1}');
    expect(Buffer.isBuffer(clientSent[1])).toBe(true);
    expect(inputs).toBe(2);
    expect(closed).toBe(1);
  });
});
