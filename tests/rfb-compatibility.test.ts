import { describe, expect, test } from "bun:test";

import {
  buildServerCutText,
  createRfbProxyState,
  filterRfbClientMessages,
  parseKasmVncClipboard,
  rewritePointerEvent,
  rewriteSetEncodings,
  rfbClientMessageLength,
  rfbServerMessageLength,
  translateClientFrame,
  translateServerChunk,
  translateServerFrame
} from "../src/rfb-compatibility";

describe("RFB compatibility proxy", () => {
  test("forwards the first three client handshake frames unchanged without manual input", () => {
    const state = createRfbProxyState();

    expect(translateClientFrame(Buffer.from("RFB 003.008\n"), state)).toEqual({
      data: Buffer.from("RFB 003.008\n"),
      manualInput: false
    });
    expect(translateClientFrame(Buffer.from([1]), state).manualInput).toBe(false);
    expect(translateClientFrame(Buffer.from([1]), state).manualInput).toBe(false);
  });

  test("calculates standard, variable, and extension client message lengths", () => {
    expect(rfbClientMessageLength(makeKeyEvent(), 0)).toBe(8);
    expect(rfbClientMessageLength(makePointerEvent(), 0)).toBe(6);
    expect(rfbClientMessageLength(makeFramebufferUpdateRequest(), 0)).toBe(10);
    expect(rfbClientMessageLength(makeSetEncodings([0, 1, 2]), 0)).toBe(16);
    expect(rfbClientMessageLength(makeClientCutText("hello"), 0)).toBe(13);
    expect(rfbClientMessageLength(makeExtension150(), 0)).toBe(10);
    expect(rfbClientMessageLength(Buffer.from([99]), 0)).toBeUndefined();
  });

  test("calculates translated server message lengths", () => {
    expect(rfbServerMessageLength(Buffer.from([2]), 0)).toBe(1);
    expect(rfbServerMessageLength(buildServerCutText("hello"), 0)).toBe(13);
    expect(rfbServerMessageLength(makeKasmVncClipboard([{ mime: "text/plain", text: "hello" }]), 0)).toBe(26);
    expect(rfbServerMessageLength(makeKasmVncClipboard([{ mime: "text/plain", text: "hello" }]).subarray(0, 12), 0)).toBeUndefined();
  });

  test("rewrites SetEncodings to allowed KasmVNC-safe encodings", () => {
    const result = rewriteSetEncodings(makeSetEncodings([0, 1, -260, -307]), 0, 20);

    expect(result.readUInt16BE(2)).toBe(2);
    expect(result.readInt32BE(4)).toBe(0);
    expect(result.readInt32BE(8)).toBe(1);
  });

  test("rewrites standard pointer events to KasmVNC extended pointer format", () => {
    const result = rewritePointerEvent(makePointerEvent({ mask: 0xff, x: 100, y: 200 }), 0);

    expect(result).toHaveLength(11);
    expect(result[0]).toBe(5);
    expect(result.readUInt16BE(1)).toBe(0x00ff);
    expect(result.readUInt16BE(3)).toBe(100);
    expect(result.readUInt16BE(5)).toBe(200);
    expect(result.readInt16BE(7)).toBe(0);
    expect(result.readInt16BE(9)).toBe(0);
  });

  test("filters batched client frames, strips extensions, rewrites pointer events, and detects manual input", () => {
    const frame = Buffer.concat([
      makeKeyEvent(),
      makeExtension150(),
      makePointerEvent({ mask: 1, x: 50, y: 75 }),
      makeClientCutText("hi")
    ]);

    const result = filterRfbClientMessages(frame);

    expect(result.manualInput).toBe(true);
    expect(result.data).toHaveLength(29);
    expect(result.data[0]).toBe(4);
    expect(result.data[8]).toBe(5);
    expect(result.data[19]).toBe(6);
  });

  test("detects keyboard, pointer movement, wheel, and clipboard paste as Manual Input independently", () => {
    expect(filterRfbClientMessages(makeKeyEvent()).manualInput).toBe(true);
    expect(filterRfbClientMessages(makePointerEvent({ mask: 0, x: 50, y: 75 })).manualInput).toBe(true);
    expect(filterRfbClientMessages(makePointerEvent({ mask: 8, x: 50, y: 75 })).manualInput).toBe(true);
    expect(filterRfbClientMessages(makeClientCutText("pasted")).manualInput).toBe(true);
  });

  test("does not classify passive framebuffer requests and SetEncodings as manual input", () => {
    const result = filterRfbClientMessages(
      Buffer.concat([makeFramebufferUpdateRequest(), makeSetEncodings([0, -260])])
    );

    expect(result.manualInput).toBe(false);
    expect(result.data[0]).toBe(3);
    expect(result.data[10]).toBe(2);
  });

  test("drops unknown or incomplete client messages after the last complete safe message", () => {
    expect(filterRfbClientMessages(Buffer.concat([makeKeyEvent(), Buffer.from([99, 0, 0])])).data).toEqual(
      makeKeyEvent()
    );
    expect(filterRfbClientMessages(makeKeyEvent().subarray(0, 4)).data).toEqual(Buffer.alloc(0));
  });

  test("converts KasmVNC BinaryClipboard text/plain to standard ServerCutText", () => {
    const clipboard = makeKasmVncClipboard([
      { mime: "image/png", text: "PNG" },
      { mime: "text/plain", text: "hello" }
    ]);
    const translated = translateServerFrame(clipboard);

    expect(parseKasmVncClipboard(clipboard)).toBe("hello");
    expect(translated).toEqual(buildServerCutText("hello"));
    expect(translated[0]).toBe(3);
    expect(translated.readUInt32BE(4)).toBe(5);
    expect(translated.subarray(8).toString("latin1")).toBe("hello");
  });

  test("translates split and coalesced server clipboard stream chunks", () => {
    const state = createRfbProxyState();
    const clipboard = makeKasmVncClipboard([{ mime: "text/plain", text: "hello" }]);

    expect(translateServerChunk(clipboard.subarray(0, 12), state)).toEqual(Buffer.alloc(0));
    expect(translateServerChunk(clipboard.subarray(12), state)).toEqual(buildServerCutText("hello"));

    expect(translateServerChunk(Buffer.concat([Buffer.from([2]), clipboard]), state)).toEqual(
      Buffer.concat([Buffer.from([2]), buildServerCutText("hello")])
    );
  });

  test("drops BinaryClipboard frames without text/plain and replaces non-Latin-1 ServerCutText chars", () => {
    expect(translateServerFrame(makeKasmVncClipboard([{ mime: "image/png", text: "PNG" }]))).toEqual(
      Buffer.alloc(0)
    );
    expect(buildServerCutText("hello 日本").subarray(8).toString("latin1")).toBe("hello ??");
  });
});

function makeKeyEvent(down = 1, key = 0x61): Buffer {
  const buffer = Buffer.alloc(8);
  buffer[0] = 4;
  buffer[1] = down;
  buffer.writeUInt32BE(key, 4);
  return buffer;
}

function makePointerEvent(options: { mask?: number; x?: number; y?: number } = {}): Buffer {
  const buffer = Buffer.alloc(6);
  buffer[0] = 5;
  buffer[1] = options.mask ?? 0;
  buffer.writeUInt16BE(options.x ?? 100, 2);
  buffer.writeUInt16BE(options.y ?? 200, 4);
  return buffer;
}

function makeFramebufferUpdateRequest(): Buffer {
  const buffer = Buffer.alloc(10);
  buffer[0] = 3;
  buffer[1] = 1;
  buffer.writeUInt16BE(1920, 6);
  buffer.writeUInt16BE(1080, 8);
  return buffer;
}

function makeSetEncodings(encodings: number[]): Buffer {
  const buffer = Buffer.alloc(4 + encodings.length * 4);
  buffer[0] = 2;
  buffer.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, index) => {
    buffer.writeInt32BE(encoding, 4 + index * 4);
  });
  return buffer;
}

function makeClientCutText(text: string): Buffer {
  const textBytes = Buffer.from(text, "latin1");
  const buffer = Buffer.alloc(8 + textBytes.length);
  buffer[0] = 6;
  buffer.writeUInt32BE(textBytes.length, 4);
  textBytes.copy(buffer, 8);
  return buffer;
}

function makeExtension150(): Buffer {
  const buffer = Buffer.alloc(10);
  buffer[0] = 150;
  buffer[1] = 1;
  buffer.writeUInt16BE(1920, 6);
  buffer.writeUInt16BE(1080, 8);
  return buffer;
}

function makeKasmVncClipboard(entries: Array<{ mime: string; text: string }>): Buffer {
  const chunks = [Buffer.from([180, 0, 0, 0, 0, 0])];
  for (const entry of entries) {
    const mime = Buffer.from(entry.mime, "utf8");
    const text = Buffer.from(entry.text, "utf8");
    const header = Buffer.alloc(1 + mime.length + 4);
    header[0] = mime.length;
    mime.copy(header, 1);
    header.writeUInt32BE(text.length, 1 + mime.length);
    chunks.push(header, text);
  }
  return Buffer.concat(chunks);
}
