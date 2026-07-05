export interface RfbClientFrameResult {
  data: Buffer;
  manualInput: boolean;
}

export interface RfbProxyState {
  clientHandshakeFrameCount: number;
  serverFrameBuffer: Buffer;
}

interface KasmVncClipboardEntry {
  dataEnd: number;
  dataStart: number;
  mimeType: string;
}

interface KasmVncClipboardRead {
  complete: boolean;
  endOffset: number;
  entries: KasmVncClipboardEntry[];
}

const RFB_CLIENT_HANDSHAKE_WEBSOCKET_FRAMES = 3;
const RFB_CLIENT_SET_PIXEL_FORMAT = 0;
const RFB_CLIENT_SET_ENCODINGS = 2;
const RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST = 3;
const RFB_CLIENT_KEY_EVENT = 4;
const RFB_CLIENT_POINTER_EVENT = 5;
const RFB_CLIENT_CUT_TEXT = 6;
const RFB_SERVER_FRAMEBUFFER_UPDATE = 0;
const RFB_SERVER_SET_COLOR_MAP_ENTRIES = 1;
const RFB_SERVER_BELL = 2;
const RFB_SERVER_CUT_TEXT = 3;
const KASMVNC_BINARY_CLIPBOARD = 180;

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
  -239,
  -224,
  ...integerRange(-32, -23),
  ...integerRange(-256, -247)
]);

export function createRfbProxyState(): RfbProxyState {
  return { clientHandshakeFrameCount: 0, serverFrameBuffer: Buffer.alloc(0) };
}

export function translateClientFrame(data: Buffer, state: RfbProxyState): RfbClientFrameResult {
  state.clientHandshakeFrameCount += 1;
  if (state.clientHandshakeFrameCount <= RFB_CLIENT_HANDSHAKE_WEBSOCKET_FRAMES) {
    return { data, manualInput: false };
  }

  return filterRfbClientMessages(data);
}

export function filterRfbClientMessages(data: Buffer): RfbClientFrameResult {
  const chunks: Buffer[] = [];
  let manualInput = false;
  let offset = 0;

  while (offset < data.length) {
    const messageType = data[offset]!;
    const messageLength = rfbClientMessageLength(data, offset);
    if (messageLength === undefined || offset + messageLength > data.length) {
      break;
    }

    if (isStandardClientMessage(messageType)) {
      if (messageType === RFB_CLIENT_SET_ENCODINGS) {
        chunks.push(rewriteSetEncodings(data, offset, messageLength));
      } else if (messageType === RFB_CLIENT_POINTER_EVENT) {
        chunks.push(rewritePointerEvent(data, offset));
        manualInput = true;
      } else {
        chunks.push(data.subarray(offset, offset + messageLength));
        manualInput = manualInput || messageType === RFB_CLIENT_KEY_EVENT || messageType === RFB_CLIENT_CUT_TEXT;
      }
    }

    offset += messageLength;
  }

  return { data: Buffer.concat(chunks), manualInput };
}

export function translateServerFrame(data: Buffer): Buffer {
  if (data[0] !== KASMVNC_BINARY_CLIPBOARD) {
    return data;
  }

  const text = parseKasmVncClipboard(data);
  return text === undefined ? Buffer.alloc(0) : buildServerCutText(text);
}

export function translateServerChunk(data: Buffer, state: RfbProxyState): Buffer {
  state.serverFrameBuffer = Buffer.concat([state.serverFrameBuffer, data]);
  const chunks: Buffer[] = [];

  while (state.serverFrameBuffer.length > 0) {
    const messageLength = rfbServerMessageLength(state.serverFrameBuffer, 0);
    if (messageLength === undefined) {
      break;
    }

    const message = state.serverFrameBuffer.subarray(0, messageLength);
    state.serverFrameBuffer = state.serverFrameBuffer.subarray(messageLength);
    const translated = translateServerFrame(message);
    if (translated.length > 0) {
      chunks.push(translated);
    }
  }

  return Buffer.concat(chunks);
}

export function rfbClientMessageLength(data: Buffer, offset: number): number | undefined {
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

  return EXTENSION_MESSAGE_LENGTHS.get(messageType);
}

export function rfbServerMessageLength(data: Buffer, offset: number): number | undefined {
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
    return kasmVncClipboardMessageLength(data, offset);
  }

  if (messageType === RFB_SERVER_FRAMEBUFFER_UPDATE) {
    return data.length - offset;
  }

  return data.length - offset;
}

export function rewriteSetEncodings(data: Buffer, offset: number, messageLength: number): Buffer {
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
  const textEntry = readKasmVncClipboard(data, 0).entries.find((entry) => entry.mimeType === "text/plain");
  return textEntry ? data.subarray(textEntry.dataStart, textEntry.dataEnd).toString("utf8") : undefined;
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

function kasmVncClipboardMessageLength(data: Buffer, offset: number): number | undefined {
  const clipboard = readKasmVncClipboard(data, offset, { stopAtPotentialNextServerMessage: true });
  return clipboard.complete ? clipboard.endOffset - offset : undefined;
}

function readKasmVncClipboard(
  data: Buffer,
  offset: number,
  options: { stopAtPotentialNextServerMessage?: boolean } = {}
): KasmVncClipboardRead {
  if (data.length - offset < 7) {
    return { complete: false, endOffset: offset, entries: [] };
  }

  const entries: KasmVncClipboardEntry[] = [];
  let cursor = offset + 6;
  while (cursor < data.length) {
    if (options.stopAtPotentialNextServerMessage && entries.length > 0 && startsKnownServerMessage(data[cursor]!)) {
      return { complete: true, endOffset: cursor, entries };
    }

    const mimeLength = data[cursor]!;
    cursor += 1;
    if (cursor + mimeLength > data.length) {
      return { complete: false, endOffset: cursor, entries };
    }

    const mimeType = data.subarray(cursor, cursor + mimeLength).toString("utf8");
    cursor += mimeLength;
    if (cursor + 4 > data.length) {
      return { complete: false, endOffset: cursor, entries };
    }

    const entryLength = data.readUInt32BE(cursor);
    cursor += 4;
    if (cursor + entryLength > data.length) {
      return { complete: false, endOffset: cursor, entries };
    }

    entries.push({
      dataEnd: cursor + entryLength,
      dataStart: cursor,
      mimeType
    });
    cursor += entryLength;
  }

  return { complete: true, endOffset: cursor, entries };
}

function startsKnownServerMessage(messageType: number): boolean {
  return (
    messageType === RFB_SERVER_FRAMEBUFFER_UPDATE ||
    messageType === RFB_SERVER_SET_COLOR_MAP_ENTRIES ||
    messageType === RFB_SERVER_BELL ||
    messageType === RFB_SERVER_CUT_TEXT ||
    messageType === KASMVNC_BINARY_CLIPBOARD
  );
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
