declare module "*rfb.js" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options: { wsProtocols: string[] }
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    clipboardPasteFrom(text: string): void;
    focus(): void;
    sendKey(keysym: number, code: string, down: boolean): void;
    disconnect(): void;
  }
}
