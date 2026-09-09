import { describe, expect, test } from "bun:test";
import { createTabCloseGuard } from "../src/cdp-tab-guard";
import type { CdpBrowserSocket } from "../src/cdp-websocket-proxy";

function fixture(
  initial: Array<{ targetId: string; type: string; subtype?: string }>,
  failCreate = false
) {
  let targets = [...initial];
  const calls: string[] = [];
  let closedSockets = 0;
  let next = 1;
  const factory = {
    connect() {
      const socket: CdpBrowserSocket = {
        readyState: WebSocket.CONNECTING,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close() {
          closedSockets++;
        },
        send(raw) {
          const command = JSON.parse(String(raw));
          calls.push(command.method);
          let result = {};
          if (command.method === "Target.getTargets")
            result = { targetInfos: targets };
          if (command.method === "Target.createTarget") {
            expect(command.params.url).toBe("about:blank");
            if (failCreate) {
              queueMicrotask(() =>
                socket.onmessage?.({
                  data: JSON.stringify({
                    id: command.id,
                    error: { code: -1, message: "failed" }
                  })
                })
              );
              return;
            }
            const targetId = `blank-${next++}`;
            targets.push({ targetId, type: "page" });
            result = { targetId };
          }
          queueMicrotask(() =>
            socket.onmessage?.({
              data: JSON.stringify({ id: command.id, result })
            })
          );
        }
      };
      queueMicrotask(() => {
        socket.readyState = WebSocket.OPEN;
        socket.onopen?.();
      });
      return socket;
    }
  };
  const guard = createTabCloseGuard(factory);
  return {
    calls,
    get targets() {
      return targets;
    },
    get closedSockets() {
      return closedSockets;
    },
    close(id: string, delayed = false) {
      return guard("work", "ws://browser/1", id, async () => {
        calls.push(`close:${id}`);
        expect(
          targets.some(
            (target) => target.type === "page" && target.targetId !== id
          )
        ).toBe(true);
        if (!delayed)
          targets = targets.filter((target) => target.targetId !== id);
        return { result: { success: true } };
      });
    }
  };
}

describe("last tab protection", () => {
  test("creates a blank before closing the final page, ignoring workers and prerender targets", async () => {
    const f = fixture([
      { targetId: "page", type: "page" },
      { targetId: "worker", type: "service_worker" },
      { targetId: "prerender", type: "page", subtype: "prerender" }
    ]);
    expect(await f.close("page")).toEqual({ result: { success: true } });
    expect(f.calls).toEqual([
      "Target.getTargets",
      "Target.createTarget",
      "close:page"
    ]);
    expect(f.closedSockets).toBe(1);
  });
  test("serializes simultaneous closes from multiple clients and leaves one blank", async () => {
    const f = fixture([
      { targetId: "a", type: "page" },
      { targetId: "b", type: "page" }
    ]);
    await Promise.all([f.close("a"), f.close("b")]);
    expect(f.targets).toEqual([{ targetId: "blank-1", type: "page" }]);
    expect(f.calls).toEqual([
      "Target.getTargets",
      "close:a",
      "Target.getTargets",
      "Target.createTarget",
      "close:b"
    ]);
    expect(f.closedSockets).toBe(2);
  });
  test("does not count a target whose close was acknowledged before destruction", async () => {
    const f = fixture([
      { targetId: "a", type: "page" },
      { targetId: "b", type: "page" }
    ]);
    await f.close("a", true);
    await f.close("b");
    expect(
      f.targets.some((target) => target.targetId.startsWith("blank-"))
    ).toBe(true);
  });
  test("fails without forwarding close if blank creation fails, then releases the queue", async () => {
    const f = fixture([{ targetId: "a", type: "page" }], true);
    await expect(f.close("a")).rejects.toThrow("CDP command failed");
    await expect(f.close("a")).rejects.toThrow("CDP command failed");
    expect(f.calls).not.toContain("close:a");
    expect(f.closedSockets).toBe(2);
  });
});
