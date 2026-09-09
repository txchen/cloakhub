import {
  createTabCloseGuard,
  parseCdpMessage,
  type CdpReply,
  type CdpMessage
} from "./cdp-tab-guard";
import type {
  BrowserRuntimeCdpSession,
  BrowserRuntimeCdpSessionMetadata
} from "./browser-runtime";

type CdpWebSocketMessage = string | Bun.BufferSource;

export interface CdpWebSocketData {
  browserTargetUrl?: string;
  relay?: ReturnType<typeof createRelay>;
  pendingMessages?: CdpWebSocketMessage[];
  profileId: string;
  requestUserAgent?: string;
  session?: BrowserRuntimeCdpSession;
  targetUrl: string;
  upstream?: CdpBrowserSocket;
}

export interface CdpBrowserSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: CdpWebSocketMessage }) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
  send(data: CdpWebSocketMessage): void;
}

export interface CdpWebSocketFactory {
  connect(url: string): CdpBrowserSocket;
}

export interface CdpSessionObserver {
  openCdpSession(
    profileId: string,
    metadata?: BrowserRuntimeCdpSessionMetadata
  ): BrowserRuntimeCdpSession;
}

export interface CdpWebSocketHandlerOptions {
  cdpSessions?: CdpSessionObserver;
  factory?: CdpWebSocketFactory;
  onBlankTab?: (profileId: string) => void;
}

const defaultWebSocketFactory: CdpWebSocketFactory = {
  connect(url: string): CdpBrowserSocket {
    return new WebSocket(url) as CdpBrowserSocket;
  }
};

export function createCdpWebSocketHandler(
  options: CdpWebSocketHandlerOptions = {}
): Bun.WebSocketHandler<CdpWebSocketData> {
  const factory = options.factory ?? defaultWebSocketFactory;
  const guard = createTabCloseGuard(factory, options.onBlankTab);

  return {
    close(ws): void {
      ws.data.relay?.dispose();
      ws.data.session?.close();
      ws.data.upstream?.close();
    },
    message(ws, message): void {
      ws.data.session?.recordMessage();
      const upstream = ws.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) {
        ws.data.relay!.send(message);
        return;
      }

      ws.data.pendingMessages = [...(ws.data.pendingMessages ?? []), message];
    },
    open(ws): void {
      ws.data.session = options.cdpSessions?.openCdpSession(ws.data.profileId, {
        remoteAddress: ws.remoteAddress,
        userAgent: ws.data.requestUserAgent
      });
      const upstream = factory.connect(ws.data.targetUrl);
      ws.data.upstream = upstream;
      const relay = createRelay(ws, upstream, guard);
      ws.data.relay = relay;

      upstream.onopen = () => {
        for (const message of ws.data.pendingMessages ?? []) {
          relay.send(message);
        }

        ws.data.pendingMessages = [];
      };

      upstream.onmessage = (event) => {
        relay.receive(event.data);
      };

      upstream.onerror = () => {
        relay.dispose();
        ws.close(1011, "CDP websocket proxy error");
      };

      upstream.onclose = () => {
        relay.dispose();
        ws.close();
      };
    }
  };
}

function createRelay(
  ws: Bun.ServerWebSocket<CdpWebSocketData>,
  upstream: CdpBrowserSocket,
  guard: ReturnType<typeof createTabCloseGuard>
) {
  const sessions = new Map<string, string>();
  const pending = new Map<
    string,
    {
      resolve(reply: CdpReply): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const expiredReplies = new Set<string>();
  let disposed = false;
  const key = (message: CdpMessage) =>
    `${message.sessionId ?? ""}:${message.id}`;
  function dispose() {
    disposed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP connection closed during tab protection"));
    }
    pending.clear();
    expiredReplies.clear();
  }
  return {
    dispose,
    send(data: CdpWebSocketMessage) {
      const command = parseCdpMessage(data);
      if (
        !command ||
        typeof command.id !== "number" ||
        !["Target.closeTarget", "Page.close"].includes(command.method ?? "") ||
        !ws.data.browserTargetUrl
      ) {
        upstream.send(data);
        return;
      }
      const targetId =
        command.method === "Target.closeTarget"
          ? command.params?.targetId
          : command.sessionId
            ? sessions.get(command.sessionId)
            : /\/devtools\/page\/([^/?]+)/.exec(ws.data.targetUrl)?.[1];
      const reply = (response: CdpReply) => {
        if (!disposed)
          ws.send(
            JSON.stringify({
              id: command.id,
              ...(command.sessionId ? { sessionId: command.sessionId } : {}),
              ...response
            })
          );
      };
      if (typeof targetId !== "string") {
        reply({
          error: {
            code: -32000,
            message: "Cannot identify the tab to close safely"
          }
        });
        return;
      }
      void guard(
        ws.data.profileId,
        ws.data.browserTargetUrl,
        targetId,
        () =>
          new Promise<CdpReply>((resolve, reject) => {
            if (disposed || upstream.readyState !== WebSocket.OPEN) {
              reject(new Error("CDP connection closed"));
              return;
            }
            const id = key(command);
            const timer = setTimeout(() => {
              pending.delete(id);
              expiredReplies.add(id);
              reject(new Error("Timed out waiting for tab close"));
            }, 10_000);
            pending.set(id, { resolve, reject, timer });
            upstream.send(data);
          })
      ).then(reply, () =>
        reply({
          error: {
            code: -32000,
            message:
              "Could not protect the last tab; close was not confirmed. Refresh the tab list before retrying."
          }
        })
      );
    },
    receive(data: CdpWebSocketMessage) {
      const message = parseCdpMessage(data);
      if (
        message?.method === "Target.attachedToTarget" &&
        message.params?.sessionId &&
        message.params.targetInfo
      ) {
        sessions.set(
          message.params.sessionId,
          message.params.targetInfo.targetId
        );
      } else if (
        message?.method === "Target.detachedFromTarget" &&
        message.params?.sessionId
      ) {
        sessions.delete(message.params.sessionId);
      }
      if (
        message &&
        typeof message.id === "number" &&
        expiredReplies.delete(key(message))
      )
        return;
      const request =
        message && typeof message.id === "number"
          ? pending.get(key(message))
          : undefined;
      if (request) {
        pending.delete(key(message!));
        clearTimeout(request.timer);
        request.resolve(
          message!.error
            ? { error: message!.error }
            : { result: message!.result }
        );
      } else ws.send(data);
    }
  };
}
