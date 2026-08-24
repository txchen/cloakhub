const MAX_CLIPBOARD_TEXT_LENGTH = 1_048_576;
const CDP_REQUEST_TIMEOUT_MS = 1500;

export interface CdpClipboardClientWebSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  send(data: string): void;
}

export interface CdpClipboardReader {
  readText(cdpPort: number): Promise<string>;
}

interface CdpClipboardReaderOptions {
  connect?: (url: string) => CdpClipboardClientWebSocket;
  listTargets?: (cdpPort: number) => Promise<unknown>;
}

interface CdpPageTarget {
  type: "page";
  webSocketDebuggerUrl: string;
}

const clipboardEvaluationExpression = `(() => {
  const clipboardStateKey = "__cloakhubClipboardState";
  const selectedText = () => {
    const active = document.activeElement;
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      typeof active.selectionStart === "number" &&
      typeof active.selectionEnd === "number"
    ) {
      return active.value.slice(active.selectionStart, active.selectionEnd);
    }
    return window.getSelection()?.toString() || "";
  };
  if (!window[clipboardStateKey]) {
    const state = { text: selectedText() };
    const capture = () => {
      const text = selectedText();
      if (text) state.text = text;
    };
    document.addEventListener("copy", capture, true);
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") capture();
    }, true);
    window[clipboardStateKey] = state;
  }
  return window[clipboardStateKey].text || "";
})()`;

export function createCdpClipboardReader(
  options: CdpClipboardReaderOptions = {}
): CdpClipboardReader {
  const listTargets = options.listTargets ?? defaultListTargets;
  const connect = options.connect ?? ((url) => new WebSocket(url) as CdpClipboardClientWebSocket);

  return {
    async readText(cdpPort: number): Promise<string> {
      const targets = pageTargets(await listTargets(cdpPort));
      for (const target of targets) {
        try {
          const text = await evaluateClipboardText(target.webSocketDebuggerUrl, connect);
          if (text) {
            return text.slice(0, MAX_CLIPBOARD_TEXT_LENGTH);
          }
        } catch {
          // A page can disappear between target discovery and evaluation. Try the next one.
        }
      }

      return "";
    }
  };
}

async function defaultListTargets(cdpPort: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json`, {
    signal: AbortSignal.timeout(CDP_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`CDP target discovery returned ${response.status}`);
  }
  return response.json();
}

function pageTargets(value: unknown): CdpPageTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (target): target is CdpPageTarget =>
      typeof target === "object" &&
      target !== null &&
      "type" in target &&
      target.type === "page" &&
      "webSocketDebuggerUrl" in target &&
      typeof target.webSocketDebuggerUrl === "string"
  );
}

function evaluateClipboardText(
  url: string,
  connect: (url: string) => CdpClipboardClientWebSocket
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(url);
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("CDP clipboard evaluation timed out")), CDP_REQUEST_TIMEOUT_MS);

    function finish(error?: Error, text = ""): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // The socket may still be connecting when a timeout fires.
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(text);
    }

    socket.onopen = () => {
      try {
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              awaitPromise: true,
              expression: clipboardEvaluationExpression,
              returnByValue: true
            }
          })
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          error?: { message?: string };
          id?: number;
          result?: { exceptionDetails?: unknown; result?: { value?: unknown } };
        };
        if (message.id !== 1) {
          return;
        }
        if (message.error || message.result?.exceptionDetails) {
          finish(new Error(message.error?.message ?? "CDP clipboard evaluation failed"));
          return;
        }
        const value = message.result?.result?.value;
        finish(undefined, typeof value === "string" ? value : "");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onerror = () => finish(new Error("CDP clipboard connection failed"));
    socket.onclose = () => finish(new Error("CDP clipboard connection closed"));
  });
}
