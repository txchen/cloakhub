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
  translateServerData,
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
    expect(rfbClientMessageLength(makeKasmVncClientClipboard("hello"), 0)).toBe(22);
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
    const result = rewriteSetEncodings(makeSetEncodings([0, 1, -260, -307, -312, -313, -1063131698]), 0, 32);

    expect(result.readUInt16BE(2)).toBe(5);
    expect(result.readInt32BE(4)).toBe(0);
    expect(result.readInt32BE(8)).toBe(1);
    expect(result.readInt32BE(12)).toBe(-312);
    expect(result.readInt32BE(16)).toBe(-313);
    expect(result.readInt32BE(20)).toBe(-1063131698);
  });

  test("forwards KasmVNC/noVNC extension client messages without counting manual input", () => {
    const result = filterRfbClientMessages(Buffer.concat([makeEnableContinuousUpdates(), makeFence()]));

    expect(result.manualInput).toBe(false);
    expect(result.data).toEqual(Buffer.concat([makeEnableContinuousUpdates(), makeFence()]));
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

  test("filters batched client frames, forwards extensions, rewrites pointer events, and detects manual input", () => {
    const frame = Buffer.concat([
      makeKeyEvent(),
      makeExtension150(),
      makePointerEvent({ mask: 1, x: 50, y: 75 }),
      makeClientCutText("hi")
    ]);

    const result = filterRfbClientMessages(frame);

    expect(result.manualInput).toBe(true);
    expect(result.data).toHaveLength(39);
    expect(result.data[0]).toBe(4);
    expect(result.data[8]).toBe(150);
    expect(result.data[18]).toBe(5);
    expect(result.data[29]).toBe(6);
  });

  test("detects keyboard, pointer movement, wheel, and clipboard paste as Manual Input independently", () => {
    expect(filterRfbClientMessages(makeKeyEvent()).manualInput).toBe(true);
    expect(filterRfbClientMessages(makePointerEvent({ mask: 0, x: 50, y: 75 })).manualInput).toBe(true);
    expect(filterRfbClientMessages(makePointerEvent({ mask: 8, x: 50, y: 75 })).manualInput).toBe(true);
    expect(filterRfbClientMessages(makeClientCutText("pasted")).manualInput).toBe(true);
    expect(filterRfbClientMessages(makeKasmVncClientClipboard("pasted")).manualInput).toBe(true);
    expect(filterRfbClientMessages(makeKasmVncClientClipboard("pasted")).data).toEqual(
      makeKasmVncClientClipboard("pasted")
    );
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

    expect(translateServerChunk(Buffer.concat([clipboard, Buffer.from([2])]), state)).toEqual(
      Buffer.concat([buildServerCutText("hello"), Buffer.from([2])])
    );

    // Only a chunk *starting* with a clipboard message is inspected: chunks are
    // not RFB-aligned, so anything else is forwarded byte-for-byte.
    const leading = Buffer.concat([Buffer.from([2]), clipboard]);
    expect(translateServerChunk(leading, state)).toEqual(leading);
  });

  test("forwards framebuffer chunks that merely start with byte 180 unchanged", () => {
    // Chunks are not aligned to RFB messages; pixel data can begin with 0xb4.
    // Real samples captured from KasmVNC on tcoci-2.
    for (const hex of [
      "b49b5749bb5d2ecbb79eda82c6529535",
      "b4a33ba94134d2b5f54aed77dee25084",
      "b4084f117c07f8cda47c38d17c4be03b"
    ]) {
      const chunk = Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(1000, 7)]);
      const state = createRfbProxyState();
      expect(translateServerData(chunk, state)).toEqual(chunk);
      expect(state.pendingServerClipboard).toBeUndefined();
      expect(translateServerFrame(chunk)).toEqual(chunk);
    }
    expect(translateServerFrame(Buffer.from([180]))).toEqual(Buffer.from([180]));
    expect(translateServerFrame(Buffer.from([180, 1, 0]))).toEqual(Buffer.from([180, 1, 0]));
  });

  test("translates a captured KasmVNC clipboard and keeps trailing stream bytes", () => {
    const clipboard = makeKasmVncClipboard([{ mime: "text/plain", text: "cloakhub" }]);
    const trailing = Buffer.from([0, 0, 0, 1, 9, 9]);
    expect(translateServerData(Buffer.concat([clipboard, trailing]), createRfbProxyState())).toEqual(
      Buffer.concat([buildServerCutText("cloakhub"), trailing])
    );
  });

  test("drops BinaryClipboard frames without text/plain and replaces non-Latin-1 ServerCutText chars", () => {
    expect(translateServerFrame(makeKasmVncClipboard([{ mime: "image/png", text: "PNG" }]))).toEqual(
      Buffer.alloc(0)
    );
    expect(buildServerCutText("hello \u0416\u0416").subarray(8).toString("latin1")).toBe("hello ??");
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

function makeEnableContinuousUpdates(): Buffer {
  const message = Buffer.alloc(10);
  message[0] = 150;
  message[1] = 1;
  message.writeUInt16BE(1920, 6);
  message.writeUInt16BE(1080, 8);
  return message;
}

function makeFence(): Buffer {
  const message = Buffer.alloc(10);
  message[0] = 248;
  return message;
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
  // Real KasmVNC layout: [180][entry count][u32 sequence] then entries.
  const chunks = [Buffer.from([180, entries.length, 0, 0, 0, 0])];
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

function makeKasmVncClientClipboard(text: string): Buffer {
  const mime = Buffer.from("text/plain", "utf8");
  const data = Buffer.from(text, "utf8");
  const buffer = Buffer.alloc(2 + 1 + mime.length + 4 + data.length);
  buffer[0] = 180;
  buffer[1] = 1;
  buffer[2] = mime.length;
  mime.copy(buffer, 3);
  buffer.writeUInt32BE(data.length, 3 + mime.length);
  data.copy(buffer, 3 + mime.length + 4);
  return buffer;
}
