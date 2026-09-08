import type { BrowserRuntimeManualViewerState } from "../browser-runtime";
import { escape } from "./dom";

const head = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/app.css"></head>`;
export function renderLoginShell(): string {
  return `${head("CloakHub Login")}<body class="login-page"><main class="login-card"><a class="brand" href="/"><span class="brand-mark">c<span>h</span></span>CloakHub</a><h1>Welcome back</h1><p>Enter your admin token to open your browser workspace.</p><form id="login-form"><label class="field"><span>Admin token</span><input name="token" type="password" autocomplete="current-password" required autofocus></label><div id="login-error" class="form-error" role="alert" hidden></div><button class="primary" type="submit">Open workspace →</button></form></main><script type="module" src="/assets/login.js"></script></body></html>`;
}
export function renderManualViewer(
  viewer: BrowserRuntimeManualViewerState
): string {
  return `${head(`CloakHub Viewer - ${viewer.profile_id}`)}<body class="remote-viewer"><main id="manual-viewer" data-profile-id="${escape(viewer.profile_id)}" data-clipboard-sync="${viewer.clipboard_sync !== false}" data-vnc-websocket-url="${escape(viewer.vnc_ws_path)}"></main><span id="remote-status">Connecting…</span><script type="module" src="/assets/viewer.js"></script></body></html>`;
}
export function renderManualViewerUnavailable(message: string): string {
  return `${head("Viewer unavailable")}<body class="login-page"><main class="login-card"><h1>Viewer unavailable</h1><p>${escape(message)}</p><p>Check the profile’s browser mode and launch status, then try reconnecting.</p><a class="secondary" href="/" target="_top">Back to profiles</a></main></body></html>`;
}
