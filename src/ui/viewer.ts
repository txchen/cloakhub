import RFB from "/assets/novnc/core/rfb.js";
import { element } from "./dom";
const viewer = element("#manual-viewer");
const status = element("#remote-status");
const id = viewer.dataset.profileId!;
let clipboardEnabled = viewer.dataset.clipboardSync === "true";
let connected = false;
let polling = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let lastClipboard = "";
const rfb = new RFB(
  viewer,
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${viewer.dataset.vncWebsocketUrl}`,
  { wsProtocols: [] }
);
rfb.scaleViewport = true;
rfb.resizeSession = false;
function post(type: string, detail: Record<string, unknown> = {}) {
  const message = { ...detail, type, profile_id: id };
  if (window.parent !== window)
    window.parent.postMessage(message, location.origin);
  window.opener?.postMessage(message, location.origin);
}
function offer(text: string) {
  if (!clipboardEnabled || !text || text === lastClipboard) return;
  lastClipboard = text;
  post("cloakhub-viewer-clipboard", { text });
}
async function pollClipboard() {
  if (polling || !connected || !clipboardEnabled) return;
  polling = true;
  try {
    const response = await fetch(
      `/ui/profiles/${encodeURIComponent(id)}/clipboard`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (response.ok) {
      const data = await response.json();
      if (typeof data.text === "string") offer(data.text);
    }
  } catch {
    /* connection state is reported by the VNC connection */
  } finally {
    polling = false;
    if (connected && clipboardEnabled)
      pollTimer = setTimeout(pollClipboard, 1000);
  }
}
async function paste(text: string) {
  if (!text || !clipboardEnabled || !connected) return;
  try {
    const response = await fetch(
      `/ui/profiles/${encodeURIComponent(id)}/clipboard`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000)
      }
    );
    if (!response.ok) throw new Error("Could not paste text");
    rfb.clipboardPasteFrom(text);
    rfb.focus();
    pasteShortcut();
  } catch {
    status.hidden = false;
    status.textContent = "Paste failed · check clipboard settings";
  }
}
function pasteShortcut() {
  rfb.sendKey(0xffe3, "ControlLeft", true);
  rfb.sendKey(0x0076, "KeyV", true);
  rfb.sendKey(0x0076, "KeyV", false);
  rfb.sendKey(0xffe3, "ControlLeft", false);
}
window.addEventListener("message", (event) => {
  if (
    event.origin !== location.origin ||
    (event.source !== window.parent && event.source !== window.opener) ||
    event.data?.profile_id !== id
  )
    return;
  if (
    event.data.type === "cloakhub-clipboard-preference" &&
    typeof event.data.enabled === "boolean"
  ) {
    const wasEnabled = clipboardEnabled;
    clipboardEnabled = event.data.enabled;
    if (!clipboardEnabled) {
      clearTimeout(pollTimer);
      lastClipboard = "";
    } else if (!wasEnabled) void pollClipboard();
  }
  if (
    event.data.type === "cloakhub-viewer-paste" &&
    typeof event.data.text === "string"
  )
    void paste(event.data.text);
});
document.addEventListener(
  "keydown",
  async (event) => {
    if (
      !clipboardEnabled ||
      event.key.toLowerCase() !== "v" ||
      (!event.ctrlKey && !event.metaKey) ||
      event.altKey ||
      event.shiftKey
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (text) await paste(text);
    else pasteShortcut();
  },
  true
);
rfb.addEventListener("connect", () => {
  connected = true;
  status.textContent = "Connected";
  setTimeout(() => {
    if (connected) status.hidden = true;
  }, 1200);
  post("cloakhub-viewer-connected");
  void pollClipboard();
});
rfb.addEventListener("disconnect", () => {
  connected = false;
  clearTimeout(pollTimer);
  status.hidden = false;
  status.textContent = "Disconnected · use Reconnect to resume";
  post("cloakhub-viewer-disconnected");
});
rfb.addEventListener("clipboard", (event) => {
  const text = (event as CustomEvent<{ text?: string }>).detail?.text;
  if (text) offer(text);
});
window.addEventListener("beforeunload", () => {
  connected = false;
  clearTimeout(pollTimer);
  rfb.disconnect();
});
