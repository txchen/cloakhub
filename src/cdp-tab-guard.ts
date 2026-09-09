import type {
  CdpBrowserSocket,
  CdpWebSocketFactory
} from "./cdp-websocket-proxy";

export interface CdpReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
export interface TargetInfo {
  targetId: string;
  type: string;
  subtype?: string;
}

/** One close queue per profile, shared by all external CDP connections. */
export function createTabCloseGuard(
  factory: CdpWebSocketFactory,
  onBlankTab?: (profileId: string) => void
) {
  const queues = new Map<string, Promise<unknown>>();
  // A successful close can acknowledge before targetDestroyed, or wait for beforeunload.
  // Exclude those targets from the next count; an extra blank tab is safer than an exit.
  const closing = new Map<
    string,
    { browserUrl: string; targets: Set<string> }
  >();
  return async (
    profileId: string,
    browserUrl: string,
    targetId: string,
    close: () => Promise<CdpReply>
  ): Promise<CdpReply> => {
    const previous = queues.get(profileId);
    const task = (async () => {
      await previous?.catch(() => undefined);
      const control = await connectControl(factory, browserUrl);
      try {
        const { targetInfos } = (await control.send("Target.getTargets")) as {
          targetInfos: TargetInfo[];
        };
        let state = closing.get(profileId);
        if (!state || state.browserUrl !== browserUrl) {
          state = { browserUrl, targets: new Set() };
          closing.set(profileId, state);
        }
        const ids = new Set(targetInfos.map((target) => target.targetId));
        for (const id of state.targets)
          if (!ids.has(id)) state.targets.delete(id);
        const target = targetInfos.find((entry) => entry.targetId === targetId);
        if (target?.type === "page" && !target.subtype) {
          const others = targetInfos.filter(
            (entry) =>
              entry.type === "page" &&
              !entry.subtype &&
              entry.targetId !== targetId &&
              !state.targets.has(entry.targetId)
          );
          if (others.length === 0) {
            await control.send("Target.createTarget", { url: "about:blank" });
            onBlankTab?.(profileId);
          }
        }
        // Reserve before dispatch: even a timed-out/disconnected close may still finish.
        if (target?.type === "page") state.targets.add(targetId);
        const response = await close();
        if (response.error || response.result?.success === false) {
          state.targets.delete(targetId);
        }
        return response;
      } finally {
        control.close();
      }
    })();
    queues.set(profileId, task);
    const cleanup = () => {
      if (queues.get(profileId) === task) queues.delete(profileId);
    };
    void task.then(cleanup, cleanup);
    return task;
  };
}

// A short-lived internal connection never counts as an external CDP sleep blocker.
function connectControl(
  factory: CdpWebSocketFactory,
  url: string
): Promise<{
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const socket: CdpBrowserSocket = factory.connect(url);
    let nextId = 1;
    const pending = new Map<
      number,
      {
        resolve(value: Record<string, unknown>): void;
        reject(error: Error): void;
      }
    >();
    let closed = false;
    const fail = () => {
      if (closed) return;
      closed = true;
      const error = new Error("Tab protection CDP connection failed");
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      clearTimeout(timeout);
      socket.close();
    };
    const timeout = setTimeout(fail, 10_000);
    socket.onerror = fail;
    socket.onclose = () => {
      socket.onclose = null;
      fail();
    };
    socket.onmessage = ({ data }) => {
      const message = parseCdpMessage(data);
      if (!message || typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error("Tab protection CDP command failed"));
      else request.resolve(message.result ?? {});
    };
    socket.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          closed = true;
          clearTimeout(timeout);
          socket.onclose = null;
          socket.close();
        }
      });
  });
}

export interface CdpMessage extends CdpReply {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: { targetId?: string; sessionId?: string; targetInfo?: TargetInfo };
}

export function parseCdpMessage(
  data: string | Bun.BufferSource
): CdpMessage | undefined {
  try {
    const value = JSON.parse(
      typeof data === "string"
        ? data
        : Buffer.from(
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : (data as Uint8Array)
          ).toString()
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
