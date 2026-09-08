import type { BrowserRuntimeManualViewer } from "./browser-runtime";
import {
  createRfbProxyState,
  translateClientFrame,
  translateServerFrame,
  type RfbProxyState
} from "./rfb-compatibility";

type VncWebSocketMessage = string | Bun.BufferSource;

export interface VncWebSocketData {
  profileId: string;
  rfb?: RfbProxyState;
  session?: BrowserRuntimeManualViewer;
  targetHost: string;
  targetPort: number;
  upstream?: VncSocket;
}

export interface VncSocket {
  close(): void;
  onclose: (() => void) | null;
  ondata: ((data: Buffer) => void) | null;
  onerror: (() => void) | null;
  write(data: Buffer): void;
}

export interface VncSocketFactory {
  connect(host: string, port: number): VncSocket;
}

export interface KasmVncClientWebSocket {
  binaryType: "arraybuffer" | "blob";
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: VncWebSocketMessage }) => void) | null;
  onopen: (() => void) | null;
  send(data: Buffer): void;
}

export interface KasmVncWebSocketConnectOptions {
  headers: Record<string, string>;
  protocols: string[];
}

export interface ManualViewerSessionObserver {
  openManualViewerSession(profileId: string): BrowserRuntimeManualViewer;
}

export interface VncWebSocketHandlerOptions {
  clipboardSyncEnabled?: (profileId: string) => boolean;
  factory?: VncSocketFactory;
  manualViewers?: ManualViewerSessionObserver;
}

function connectKasmVncWebSocket(
  url: string,
  options: KasmVncWebSocketConnectOptions
): KasmVncClientWebSocket {
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: KasmVncWebSocketConnectOptions
  ) => KasmVncClientWebSocket;
  return new BunWebSocket(url, options);
}

export function createKasmVncWebSocketFactory(
  connect: (
    url: string,
    options: KasmVncWebSocketConnectOptions
  ) => KasmVncClientWebSocket = connectKasmVncWebSocket
): VncSocketFactory {
  return {
    connect(host: string, port: number): VncSocket {
      const origin = `http://${host}:${port}`;
      const socket = connect(`ws://${host}:${port}/websockify`, {
        headers: {
          Origin: origin,
          "Sec-WebSocket-Origin": origin
        },
        protocols: ["binary"]
      });
      socket.binaryType = "arraybuffer";
      let open = false;
      const pendingWrites: Buffer[] = [];
      const vncSocket: VncSocket = {
        close: () => {
          pendingWrites.length = 0;
          socket.close();
        },
        onclose: null,
        ondata: null,
        onerror: null,
        write: (data) => {
          if (open) {
            socket.send(data);
          } else {
            pendingWrites.push(Buffer.from(data));
          }
        }
      };
      socket.onopen = () => {
        open = true;
        for (const data of pendingWrites.splice(0)) {
          socket.send(data);
        }
      };
      socket.onmessage = (event) => vncSocket.ondata?.(toBuffer(event.data));
      socket.onerror = () => vncSocket.onerror?.();
      socket.onclose = () => vncSocket.onclose?.();
      return vncSocket;
    }
  };
}

const defaultVncSocketFactory = createKasmVncWebSocketFactory();

export function createVncWebSocketHandler(
  options: VncWebSocketHandlerOptions = {}
): Bun.WebSocketHandler<VncWebSocketData> {
  const factory = options.factory ?? defaultVncSocketFactory;

  return {
    close(ws): void {
      ws.data.session?.close();
      ws.data.upstream?.close();
    },
    message(ws, message): void {
      const state = ws.data.rfb ?? createRfbProxyState();
      ws.data.rfb = state;
      const result = translateClientFrame(
        toBuffer(message),
        state,
        options.clipboardSyncEnabled?.(ws.data.profileId) ?? true
      );
      if (result.manualInput) {
        ws.data.session?.recordInput();
      }

      if (result.data.length > 0) {
        ws.data.upstream?.write(result.data);
      }
    },
    open(ws): void {
      ws.data.rfb = createRfbProxyState();
      ws.data.session = options.manualViewers?.openManualViewerSession(
        ws.data.profileId
      );
      const upstream = factory.connect(ws.data.targetHost, ws.data.targetPort);
      ws.data.upstream = upstream;

      upstream.ondata = (data) => {
        const translated = translateServerFrame(data);
        if (translated.length > 0) {
          ws.send(translated);
        }
      };

      upstream.onerror = () => {
        ws.close(1011, "VNC websocket proxy error");
      };

      upstream.onclose = () => {
        ws.close();
      };
    }
  };
}

function toBuffer(message: VncWebSocketMessage): Buffer {
  if (typeof message === "string") {
    return Buffer.from(message);
  }

  if (message instanceof ArrayBuffer) {
    return Buffer.from(message);
  }

  if (ArrayBuffer.isView(message)) {
    return Buffer.from(
      message.buffer as ArrayBuffer,
      message.byteOffset,
      message.byteLength
    );
  }

  return Buffer.from(new Uint8Array(message));
}
