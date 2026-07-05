import type { BrowserRuntimeCdpSession, BrowserRuntimeCdpSessionMetadata } from "./browser-runtime";

type CdpWebSocketMessage = string | Bun.BufferSource;

export interface CdpWebSocketData {
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

  return {
    close(ws): void {
      ws.data.session?.close();
      ws.data.upstream?.close();
    },
    message(ws, message): void {
      ws.data.session?.recordMessage();
      const upstream = ws.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(message);
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

      upstream.onopen = () => {
        for (const message of ws.data.pendingMessages ?? []) {
          upstream.send(message);
        }

        ws.data.pendingMessages = [];
      };

      upstream.onmessage = (event) => {
        ws.send(event.data);
      };

      upstream.onerror = () => {
        ws.close(1011, "CDP websocket proxy error");
      };

      upstream.onclose = () => {
        ws.close();
      };
    }
  };
}
