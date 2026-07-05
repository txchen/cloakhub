import { connect as connectTcp } from "node:net";

import type { BrowserRuntimeManualViewer } from "./browser-runtime";

type VncWebSocketMessage = string | Bun.BufferSource;

export interface VncWebSocketData {
  profileId: string;
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

export interface ManualViewerSessionObserver {
  openManualViewerSession(profileId: string): BrowserRuntimeManualViewer;
}

export interface VncWebSocketHandlerOptions {
  factory?: VncSocketFactory;
  manualViewers?: ManualViewerSessionObserver;
}

const defaultVncSocketFactory: VncSocketFactory = {
  connect(host: string, port: number): VncSocket {
    const socket = connectTcp({ host, port });
    const vncSocket: VncSocket = {
      close: () => socket.end(),
      onclose: null,
      ondata: null,
      onerror: null,
      write: (data) => socket.write(data)
    };
    socket.on("data", (data) => vncSocket.ondata?.(typeof data === "string" ? Buffer.from(data) : data));
    socket.on("error", () => vncSocket.onerror?.());
    socket.on("close", () => vncSocket.onclose?.());
    return vncSocket;
  }
};

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
      ws.data.upstream?.write(toBuffer(message));
    },
    open(ws): void {
      ws.data.session = options.manualViewers?.openManualViewerSession(ws.data.profileId);
      const upstream = factory.connect(ws.data.targetHost, ws.data.targetPort);
      ws.data.upstream = upstream;

      upstream.ondata = (data) => {
        ws.send(data);
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
    return Buffer.from(message.buffer as ArrayBuffer, message.byteOffset, message.byteLength);
  }

  return Buffer.from(new Uint8Array(message));
}
