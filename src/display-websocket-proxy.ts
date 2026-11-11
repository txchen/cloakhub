import type { BrowserRuntimeManualViewer } from "./browser-runtime";

/**
 * Relays a viewer's voxl stream WebSocket to the Browser Instance's private voxl
 * server, observing Manual Input and enforcing the profile's clipboard preference.
 *
 * voxl's wire protocol (web/src/protocol.ts upstream): binary messages start with a
 * type byte; client text messages are short comma-separated commands; server text
 * messages are JSON objects with a `t` field.
 */

type DisplayWebSocketMessage = string | Bun.BufferSource;

const displayDebug = process.env.CLOAKHUB_DISPLAY_DEBUG === "1";

/** Client commands that are a person acting on the desktop. */
const MANUAL_INPUT_COMMANDS = new Set(["m", "b", "sp", "k", "c"]);
/** Client commands the viewer never needs: microphone and dynamic resolution. */
const BLOCKED_CLIENT_COMMANDS = new Set(["mi", "sz"]);
const CLIENT_CLIPBOARD_COMMAND = "c";

const BIN_SERVER_CLIP_IMAGE = 0x04;
const BIN_CLIENT_CLIP_IMAGE = 0x11;
const BIN_CLIENT_MIC_OPUS = 0x12;
const BIN_CLIENT_MIC_PCM = 0x13;

export interface DisplayWebSocketData {
  kind: "display";
  profileId: string;
  session?: BrowserRuntimeManualViewer;
  targetHost: string;
  targetPort: number;
  upstream?: DisplayUpstream;
}

export interface DisplayUpstream {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((data: string | Buffer) => void) | null;
  send(data: string | Buffer): void;
}

export interface DisplayUpstreamFactory {
  connect(host: string, port: number): DisplayUpstream;
}

export interface ManualViewerSessionObserver {
  openManualViewerSession(profileId: string): BrowserRuntimeManualViewer;
}

export interface DisplayWebSocketHandlerOptions {
  clipboardSyncEnabled?: (profileId: string) => boolean;
  factory?: DisplayUpstreamFactory;
  manualViewers?: ManualViewerSessionObserver;
}

export interface ClientMessageDecision {
  forward: boolean;
  manualInput: boolean;
}

export function classifyClientMessage(
  message: string | Buffer,
  clipboardSync: boolean
): ClientMessageDecision {
  if (typeof message === "string") {
    const command = message.split(",", 1)[0]!;
    if (BLOCKED_CLIENT_COMMANDS.has(command)) {
      return { forward: false, manualInput: false };
    }
    if (command === CLIENT_CLIPBOARD_COMMAND && !clipboardSync) {
      return { forward: false, manualInput: false };
    }
    return { forward: true, manualInput: MANUAL_INPUT_COMMANDS.has(command) };
  }

  const type = message[0];
  if (type === BIN_CLIENT_MIC_OPUS || type === BIN_CLIENT_MIC_PCM) {
    return { forward: false, manualInput: false };
  }
  if (type === BIN_CLIENT_CLIP_IMAGE) {
    return clipboardSync
      ? { forward: true, manualInput: true }
      : { forward: false, manualInput: false };
  }
  return { forward: true, manualInput: false };
}

export function shouldForwardServerMessage(
  message: string | Buffer,
  clipboardSync: boolean
): boolean {
  if (clipboardSync) {
    return true;
  }
  if (typeof message === "string") {
    // Server text is small JSON; only clipboard updates carry desktop data. voxl
    // serializes keys in sorted order, so `t` is not necessarily first.
    if (!message.includes('"clip"')) return true;
    try {
      return (JSON.parse(message) as { t?: unknown }).t !== "clip";
    } catch {
      return false;
    }
  }
  return message[0] !== BIN_SERVER_CLIP_IMAGE;
}

export function createVoxlUpstreamFactory(): DisplayUpstreamFactory {
  return {
    connect(host: string, port: number): DisplayUpstream {
      // No Origin header: voxl treats non-browser clients on loopback as trusted.
      const socket = new WebSocket(`ws://${host}:${port}/ws`);
      socket.binaryType = "arraybuffer";
      let open = false;
      const pending: (string | Buffer)[] = [];
      const upstream: DisplayUpstream = {
        close: () => {
          pending.length = 0;
          socket.close();
        },
        onclose: null,
        onerror: null,
        onmessage: null,
        send: (data) => {
          if (open) socket.send(data);
          else pending.push(data);
        }
      };
      socket.onopen = () => {
        open = true;
        for (const data of pending.splice(0)) socket.send(data);
      };
      socket.onmessage = (event) =>
        upstream.onmessage?.(
          typeof event.data === "string" ? event.data : toBuffer(event.data)
        );
      socket.onerror = () => upstream.onerror?.();
      socket.onclose = () => upstream.onclose?.();
      return upstream;
    }
  };
}

const defaultFactory = createVoxlUpstreamFactory();

export function createDisplayWebSocketHandler(
  options: DisplayWebSocketHandlerOptions = {}
): Bun.WebSocketHandler<DisplayWebSocketData> {
  const factory = options.factory ?? defaultFactory;
  const clipboardSync = (profileId: string) =>
    options.clipboardSyncEnabled?.(profileId) ?? true;

  return {
    close(ws, code, reason): void {
      debugLog(ws.data.profileId, `client closed code=${code} reason=${JSON.stringify(reason)}`);
      ws.data.session?.close();
      ws.data.upstream?.close();
    },
    message(ws, message): void {
      const data = typeof message === "string" ? message : toBuffer(message);
      const decision = classifyClientMessage(data, clipboardSync(ws.data.profileId));
      if (decision.manualInput) {
        ws.data.session?.recordInput();
      }
      if (decision.forward) {
        ws.data.upstream?.send(data);
      }
    },
    open(ws): void {
      ws.data.session = options.manualViewers?.openManualViewerSession(ws.data.profileId);
      const upstream = factory.connect(ws.data.targetHost, ws.data.targetPort);
      ws.data.upstream = upstream;
      debugLog(ws.data.profileId, "viewer connected");

      upstream.onmessage = (data) => {
        if (!shouldForwardServerMessage(data, clipboardSync(ws.data.profileId))) {
          return;
        }
        // 0 means Bun dropped the message. A dropped H.264 frame corrupts the stream
        // until the next keyframe, so close and let the viewer reconnect cleanly.
        if (ws.send(data) === 0) {
          debugLog(ws.data.profileId, `send dropped buffered=${ws.getBufferedAmount()}`);
          ws.close(1011, "Viewer stream backpressure");
        }
      };
      upstream.onerror = () => {
        debugLog(ws.data.profileId, "upstream error");
        ws.close(1011, "Viewer stream proxy error");
      };
      upstream.onclose = () => {
        debugLog(ws.data.profileId, "upstream closed");
        ws.close();
      };
    }
  };
}

function debugLog(profileId: string, message: string): void {
  if (displayDebug) {
    console.log(`[display] ${new Date().toISOString()} profile=${profileId} ${message}`);
  }
}

function toBuffer(message: DisplayWebSocketMessage): Buffer {
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
