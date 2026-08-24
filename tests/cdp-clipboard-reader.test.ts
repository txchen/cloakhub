import { describe, expect, test } from "bun:test";

import {
  createCdpClipboardReader,
  type CdpClipboardClientWebSocket
} from "../src/cdp-clipboard-reader";

describe("CdpClipboardReader", () => {
  test("reads copied text from a page target selection", async () => {
    const sockets: CdpClipboardClientWebSocket[] = [];
    const sent: unknown[] = [];
    const reader = createCdpClipboardReader({
      connect: () => {
        const socket: CdpClipboardClientWebSocket = {
          close: () => undefined,
          onclose: null,
          onerror: null,
          onmessage: null,
          onopen: null,
          send(data) {
            sent.push(JSON.parse(data));
            queueMicrotask(() => {
              socket.onmessage?.({
                data: JSON.stringify({
                  id: 1,
                  result: { result: { type: "string", value: "copied from browser" } }
                })
              });
            });
          }
        };
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      listTargets: async () => [
        { type: "service_worker", webSocketDebuggerUrl: "ws://worker" },
        { type: "page", webSocketDebuggerUrl: "ws://page" }
      ]
    });

    await expect(reader.readText(5100)).resolves.toBe("copied from browser");
    expect(sockets).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 1, method: "Runtime.evaluate" });
    expect(JSON.stringify(sent[0])).toContain("window.getSelection");
  });

  test("returns empty text when no page exposes a selection", async () => {
    const reader = createCdpClipboardReader({
      connect: () => {
        throw new Error("should not connect");
      },
      listTargets: async () => [{ type: "other" }]
    });

    await expect(reader.readText(5100)).resolves.toBe("");
  });
});
