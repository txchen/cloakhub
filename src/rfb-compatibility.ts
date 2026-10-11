export interface RfbClientFrameResult {
  data: Buffer;
  manualInput: boolean;
}

export interface RfbProxyState {
  clientHandshakeFrameCount: number;
  /** A KasmVNC BinaryClipboard message split across upstream chunks. */
  pendingServerClipboard?: Buffer;
}

export type ServerClipboardDecision =
  | "passthrough"
  | "translated"
  | "buffered"
  | "not-clipboard";

const RFB_CLIENT_HANDSHAKE_WEBSOCKET_FRAMES = 3;
const RFB_CLIENT_SET_PIXEL_FORMAT = 0;
const RFB_CLIENT_SET_ENCODINGS = 2;
const RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST = 3;
const RFB_CLIENT_KEY_EVENT = 4;
const RFB_CLIENT_POINTER_EVENT = 5;
const RFB_CLIENT_CUT_TEXT = 6;
const RFB_CLIENT_KASMVNC_BINARY_CLIPBOARD = 180;
const RFB_SERVER_FRAMEBUFFER_UPDATE = 0;
const RFB_SERVER_SET_COLOR_MAP_ENTRIES = 1;
const RFB_SERVER_BELL = 2;
const RFB_SERVER_CUT_TEXT = 3;
const KASMVNC_BINARY_CLIPBOARD = 180;
const PSEUDO_ENCODING_EXTENDED_CLIPBOARD = -1063131698;

const FIXED_CLIENT_MESSAGE_LENGTHS = new Map<number, number>([
  [RFB_CLIENT_SET_PIXEL_FORMAT, 20],
  [RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST, 10],
  [RFB_CLIENT_KEY_EVENT, 8],
  [RFB_CLIENT_POINTER_EVENT, 6]
]);

const EXTENSION_MESSAGE_LENGTHS = new Map<number, number>([
  [150, 10],
  [248, 10],
  [252, 4],
  [255, 4]
]);

const ALLOWED_ENCODINGS = new Set<number>([
  0,
  1,
  2,
  5,
  7,
  16,
  -313,
  -312,
  -239,
  -224,
  PSEUDO_ENCODING_EXTENDED_CLIPBOARD,
  ...integerRange(-32, -23),
  ...integerRange(-256, -247)
]);

export function createRfbProxyState(): RfbProxyState {
  return { clientHandshakeFrameCount: 0 };
}

export function translateClientFrame(
  data: Buffer,
  state: RfbProxyState,
  clipboardSync = true
): RfbClientFrameResult {
  state.clientHandshakeFrameCount += 1;
  if (
    state.clientHandshakeFrameCount <= RFB_CLIENT_HANDSHAKE_WEBSOCKET_FRAMES
  ) {
    return { data, manualInput: false };
  }

  return filterRfbClientMessages(data, clipboardSync);
}

export function filterRfbClientMessages(
  data: Buffer,
  clipboardSync = true
): RfbClientFrameResult {
  const chunks: Buffer[] = [];
  let manualInput = false;
  let offset = 0;

  while (offset < data.length) {
    const messageType = data[offset]!;
    const messageLength = rfbClientMessageLength(data, offset);
    if (messageLength === undefined || offset + messageLength > data.length) {
      break;
    }

    if (
      !clipboardSync &&
      (messageType === RFB_CLIENT_CUT_TEXT ||
        messageType === RFB_CLIENT_KASMVNC_BINARY_CLIPBOARD)
    ) {
      offset += messageLength;
      continue;
    }
    if (isStandardClientMessage(messageType)) {
      if (messageType === RFB_CLIENT_SET_ENCODINGS) {
        chunks.push(rewriteSetEncodings(data, offset, messageLength));
      } else if (messageType === RFB_CLIENT_POINTER_EVENT) {
        chunks.push(rewritePointerEvent(data, offset));
        manualInput = true;
      } else {
        chunks.push(data.subarray(offset, offset + messageLength));
        manualInput =
          manualInput ||
          messageType === RFB_CLIENT_KEY_EVENT ||
          messageType === RFB_CLIENT_CUT_TEXT;
      }
    } else if (EXTENSION_MESSAGE_LENGTHS.has(messageType)) {
      chunks.push(data.subarray(offset, offset + messageLength));
    } else if (messageType === RFB_CLIENT_KASMVNC_BINARY_CLIPBOARD) {
      chunks.push(data.subarray(offset, offset + messageLength));
      manualInput = true;
    }

    offset += messageLength;
  }

  return { data: Buffer.concat(chunks), manualInput };
}

/**
 * Translate one upstream KasmVNC websocket chunk for a stock noVNC client.
 *
 * KasmVNC websocket chunks are NOT aligned to RFB message boundaries: a chunk
 * can start in the middle of framebuffer data, so a first byte of 180 is often
 * just pixel data. Only a chunk that parses strictly as a KasmVNC
 * BinaryClipboard message ([180][count][u32 seq] then count entries of
 * [u8 mimeLen][mime][u32 len][data]) is rewritten; anything else is forwarded
 * byte-for-byte. Dropping stream bytes desynchronizes RFB and disconnects the
 * client.
 */
export function translateServerData(
  data: Buffer,
  state: RfbProxyState,
  onDecision?: (decision: ServerClipboardDecision, detail: string) => void
): Buffer {
  let input = data;
  if (state.pendingServerClipboard) {
    input = Buffer.concat([state.pendingServerClipboard, data]);
    state.pendingServerClipboard = undefined;
  } else if (data[0] !== KASMVNC_BINARY_CLIPBOARD) {
    return data;
  }

  const parsed = readKasmVncServerClipboard(input);
  if (parsed.status === "incomplete") {
    state.pendingServerClipboard = input;
    onDecision?.("buffered", `have=${input.length}`);
    return Buffer.alloc(0);
  }

  if (parsed.status === "invalid") {
    onDecision?.("not-clipboard", `len=${input.length} reason=${parsed.reason}`);
    return input;
  }

  const rest = input.subarray(parsed.end);
  const cutText =
    parsed.text === undefined ? Buffer.alloc(0) : buildServerCutText(parsed.text);
  onDecision?.("translated", `clipboard=${parsed.end} rest=${rest.length}`);
  return rest.length > 0 ? Buffer.concat([cutText, rest]) : cutText;
}

/** Stateless form of {@link translateServerData} for a single chunk. */
export function translateServerFrame(data: Buffer): Buffer {
  const state = createRfbProxyState();
  const translated = translateServerData(data, state);
  return state.pendingServerClipboard ? data : translated;
}

/** @deprecated use translateServerData; kept for existing callers. */
export function translateServerChunk(
  data: Buffer,
  state: RfbProxyState
): Buffer {
  return translateServerData(data, state);
}

const MAX_CLIPBOARD_ENTRIES = 16;
const MAX_CLIPBOARD_ENTRY_BYTES = 16 * 1024 * 1024;
const MIME_TYPE_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/i;
const MIME_PREFIX_PATTERN = /^[a-z]*(\/[a-z0-9.+-]*)?$/i;

type KasmVncServerClipboardParse =
  | { status: "complete"; end: number; text?: string }
  | { status: "incomplete" }
  | { status: "invalid"; reason: string };

export function readKasmVncServerClipboard(
  data: Buffer
): KasmVncServerClipboardParse {
  if (data[0] !== KASMVNC_BINARY_CLIPBOARD) {
    return { status: "invalid", reason: "type" };
  }
  // "incomplete" only delays bytes: if later data proves this is not a
  // clipboard message, the buffered bytes are forwarded unchanged.
  if (data.length < 2) return { status: "incomplete" };
  const count = data[1]!;
  if (count < 1 || count > MAX_CLIPBOARD_ENTRIES) {
    return { status: "invalid", reason: `count=${count}` };
  }
  if (data.length < 7) return { status: "incomplete" };

  let cursor = 6;
  let text: string | undefined;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 1 > data.length) return { status: "incomplete" };
    const mimeLength = data[cursor]!;
    if (mimeLength < 3 || mimeLength > 64) {
      return { status: "invalid", reason: `mimeLength=${mimeLength}` };
    }
    cursor += 1;
    if (cursor + mimeLength > data.length) {
      const prefix = data.subarray(cursor).toString("latin1");
      return MIME_PREFIX_PATTERN.test(prefix)
        ? { status: "incomplete" }
        : { status: "invalid", reason: "mime" };
    }
    const mimeType = data.subarray(cursor, cursor + mimeLength).toString("latin1");
    if (!MIME_TYPE_PATTERN.test(mimeType)) {
      return { status: "invalid", reason: "mime" };
    }
    cursor += mimeLength;
    if (cursor + 4 > data.length) return { status: "incomplete" };
    const entryLength = data.readUInt32BE(cursor);
    if (entryLength > MAX_CLIPBOARD_ENTRY_BYTES) {
      return { status: "invalid", reason: `entryLength=${entryLength}` };
    }
    cursor += 4;
    if (cursor + entryLength > data.length) return { status: "incomplete" };
    if (text === undefined && mimeType === "text/plain") {
      text = data.subarray(cursor, cursor + entryLength).toString("utf8");
    }
    cursor += entryLength;
  }

  return { status: "complete", end: cursor, text };
}

export function rfbClientMessageLength(
  data: Buffer,
  offset: number
): number | undefined {
  if (offset >= data.length) {
    return undefined;
  }

  const messageType = data[offset]!;
  const fixedLength = FIXED_CLIENT_MESSAGE_LENGTHS.get(messageType);
  if (fixedLength !== undefined) {
    return fixedLength;
  }

  const remaining = data.length - offset;
  if (messageType === RFB_CLIENT_SET_ENCODINGS && remaining >= 4) {
    return 4 + data.readUInt16BE(offset + 2) * 4;
  }

  if (messageType === RFB_CLIENT_CUT_TEXT && remaining >= 8) {
    return 8 + data.readUInt32BE(offset + 4);
  }

  if (messageType === RFB_CLIENT_KASMVNC_BINARY_CLIPBOARD) {
    return kasmVncClientClipboardMessageLength(data, offset);
  }

  return EXTENSION_MESSAGE_LENGTHS.get(messageType);
}

export function rfbServerMessageLength(
  data: Buffer,
  offset: number
): number | undefined {
  if (offset >= data.length) {
    return undefined;
  }

  const messageType = data[offset]!;
  if (messageType === RFB_SERVER_BELL) {
    return 1;
  }

  const remaining = data.length - offset;
  if (messageType === RFB_SERVER_CUT_TEXT && remaining >= 8) {
    return 8 + data.readUInt32BE(offset + 4);
  }

  if (messageType === RFB_SERVER_SET_COLOR_MAP_ENTRIES && remaining >= 6) {
    return 6 + data.readUInt16BE(offset + 4) * 6;
  }

  if (messageType === KASMVNC_BINARY_CLIPBOARD) {
    const parsed = readKasmVncServerClipboard(data.subarray(offset));
    return parsed.status === "complete" ? parsed.end : undefined;
  }

  if (messageType === RFB_SERVER_FRAMEBUFFER_UPDATE) {
    return data.length - offset;
  }

  return data.length - offset;
}

export function rewriteSetEncodings(
  data: Buffer,
  offset: number,
  messageLength: number
): Buffer {
  const encodingCount = data.readUInt16BE(offset + 2);
  const kept: number[] = [];

  for (let index = 0; index < encodingCount; index += 1) {
    const encoding = data.readInt32BE(offset + 4 + index * 4);
    if (ALLOWED_ENCODINGS.has(encoding)) {
      kept.push(encoding);
    }
  }

  if (kept.length === encodingCount) {
    return data.subarray(offset, offset + messageLength);
  }

  const rewritten = Buffer.alloc(4 + kept.length * 4);
  rewritten[0] = RFB_CLIENT_SET_ENCODINGS;
  rewritten[1] = 0;
  rewritten.writeUInt16BE(kept.length, 2);
  kept.forEach((encoding, index) => {
    rewritten.writeInt32BE(encoding, 4 + index * 4);
  });
  return rewritten;
}

export function rewritePointerEvent(data: Buffer, offset: number): Buffer {
  const rewritten = Buffer.alloc(11);
  rewritten[0] = RFB_CLIENT_POINTER_EVENT;
  rewritten.writeUInt16BE(data[offset + 1]!, 1);
  rewritten.writeUInt16BE(data.readUInt16BE(offset + 2), 3);
  rewritten.writeUInt16BE(data.readUInt16BE(offset + 4), 5);
  rewritten.writeInt16BE(0, 7);
  rewritten.writeInt16BE(0, 9);
  return rewritten;
}

export function parseKasmVncClipboard(data: Buffer): string | undefined {
  const parsed = readKasmVncServerClipboard(data);
  return parsed.status === "complete" ? parsed.text : undefined;
}

export function buildServerCutText(text: string): Buffer {
  const textBytes = Buffer.from(latin1WithReplacement(text), "latin1");
  const message = Buffer.alloc(8 + textBytes.length);
  message[0] = RFB_SERVER_CUT_TEXT;
  message.writeUInt32BE(textBytes.length, 4);
  textBytes.copy(message, 8);
  return message;
}

function isStandardClientMessage(messageType: number): boolean {
  return (
    messageType === RFB_CLIENT_SET_PIXEL_FORMAT ||
    messageType === RFB_CLIENT_SET_ENCODINGS ||
    messageType === RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST ||
    messageType === RFB_CLIENT_KEY_EVENT ||
    messageType === RFB_CLIENT_POINTER_EVENT ||
    messageType === RFB_CLIENT_CUT_TEXT
  );
}

function kasmVncClientClipboardMessageLength(
  data: Buffer,
  offset: number
): number | undefined {
  if (data.length - offset < 2) {
    return undefined;
  }

  const entryCount = data[offset + 1]!;
  let cursor = offset + 2;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 1 > data.length) {
      return undefined;
    }

    const mimeLength = data[cursor]!;
    cursor += 1;
    if (cursor + mimeLength + 4 > data.length) {
      return undefined;
    }

    cursor += mimeLength;
    const entryLength = data.readUInt32BE(cursor);
    cursor += 4;
    if (cursor + entryLength > data.length) {
      return undefined;
    }

    cursor += entryLength;
  }

  return cursor - offset;
}

function integerRange(start: number, endInclusive: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= endInclusive; value += 1) {
    values.push(value);
  }
  return values;
}

function latin1WithReplacement(text: string): string {
  return Array.from(text)
    .map((character) => (character.codePointAt(0)! <= 0xff ? character : "?"))
    .join("");
}
