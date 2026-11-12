import { element } from "./dom";

const viewer = element("#manual-viewer");
const frame = element<HTMLIFrameElement>("#display-frame");
const status = element("#remote-status");
const id = viewer.dataset.profileId!;
let clipboardEnabled = viewer.dataset.clipboardSync === "true";
let connected = false;
let polling = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let lastClipboard = "";

function post(type: string, detail: Record<string, unknown> = {}) {
  const message = { ...detail, type, profile_id: id };
  if (window.parent !== window)
    window.parent.postMessage(message, location.origin);
  window.opener?.postMessage(message, location.origin);
}
function showStatus(text: string, hideAfterMs?: number) {
  status.hidden = false;
  status.textContent = text;
  if (hideAfterMs !== undefined)
    setTimeout(() => {
      if (connected && status.textContent === text) status.hidden = true;
    }, hideAfterMs);
}
function setConnected(next: boolean) {
  if (next === connected) return;
  connected = next;
  if (connected) {
    showStatus("Connected", 1200);
    post("cloakhub-viewer-connected");
    void pollClipboard();
  } else {
    clearTimeout(pollTimer);
    showStatus("Reconnecting…");
    post("cloakhub-viewer-disconnected");
  }
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
    /* connection state is reported by the display stream */
  } finally {
    polling = false;
    if (connected && clipboardEnabled)
      pollTimer = setTimeout(pollClipboard, 1000);
  }
}

/** Types Ctrl+V into the display page, which forwards keysyms to the desktop. */
function pasteShortcut() {
  const win = frame.contentWindow as (Window & typeof globalThis) | null;
  const target = frame.contentDocument?.getElementById("kbd");
  if (!win || !target) return;
  const key = (type: string, init: KeyboardEventInit) =>
    target.dispatchEvent(
      new win.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    );
  key("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
  key("keydown", { key: "v", code: "KeyV", ctrlKey: true });
  key("keyup", { key: "v", code: "KeyV", ctrlKey: true });
  key("keyup", { key: "Control", code: "ControlLeft" });
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
    frame.contentWindow?.focus();
    pasteShortcut();
  } catch {
    showStatus("Paste failed · check clipboard settings");
  }
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

// The display page hides its #status element once the stream says hello and shows
// it again ("Reconnecting…") when the stream drops; it reconnects by itself.
function watchDisplayPage() {
  const doc = frame.contentDocument;
  const displayStatus = doc?.getElementById("status");
  if (!doc || !displayStatus) {
    setConnected(false);
    showStatus("Viewer unavailable · use Reconnect to retry");
    return;
  }
  const update = () => {
    const hidden = displayStatus.style.display === "none";
    if (hidden) setConnected(true);
    else {
      if (connected) setConnected(false);
      showStatus(displayStatus.textContent?.trim() || "Connecting…");
    }
  };
  new MutationObserver(update).observe(displayStatus, {
    attributes: true,
    attributeFilter: ["style"],
    characterData: true,
    childList: true,
    subtree: true
  });
  update();
  frame.contentWindow?.focus();
}

// Report the stream's live frame rate and bitrate to the workspace toolbar.
setInterval(() => {
  if (!connected) return;
  const stats = (
    frame.contentWindow as { voxlStats?: { fps?: number; kbps?: number } } | null
  )?.voxlStats;
  if (typeof stats?.fps === "number" && typeof stats.kbps === "number")
    post("cloakhub-viewer-stats", { fps: stats.fps, kbps: stats.kbps });
}, 1000);

if (!window.isSecureContext) {
  // Browsers only decode video on secure pages. Point at the built-in HTTPS
  // listener when the Hub runs one.
  const port = viewer.dataset.httpsPort;
  const notice = document.createElement("div");
  notice.className = "viewer-notice";
  const text = document.createElement("p");
  text.textContent =
    "The live viewer needs HTTPS or localhost: browsers only decode video on secure pages.";
  notice.append(text);
  if (port) {
    const link = document.createElement("a");
    link.href = `https://${location.hostname}:${port}/`;
    link.target = "_top";
    link.className = "primary";
    link.textContent = "Open CloakHub over HTTPS";
    const hint = document.createElement("small");
    hint.textContent =
      "The certificate is self-signed: accept the browser warning once, then sign in.";
    notice.append(link, hint);
  }
  viewer.replaceChildren(notice);
  status.hidden = true;
} else {
  frame.addEventListener("load", watchDisplayPage);
  frame.src = viewer.dataset.displayPath!;
}

window.addEventListener("beforeunload", () => {
  connected = false;
  clearTimeout(pollTimer);
});
