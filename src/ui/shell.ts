import type { CloakHubConfig } from "../config";
import type { PresentedBrowserProfile } from "../profile-presentation";

export function renderShell(
  config: CloakHubConfig,
  profiles: PresentedBrowserProfile[]
): string {
  const data = JSON.stringify({
    profiles,
    limit: config.maxRunningInstances
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CloakHub</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/app.css">
</head><body>
<div class="app-layout">
  <aside class="navigation" aria-label="Profile navigation">
    <div class="navigation-header"><a class="brand" href="/" aria-label="CloakHub home"><span class="brand-mark">c<span>h</span></span>CloakHub</a><button id="sidebar-toggle" class="icon-button" aria-label="Hide sidebar" aria-expanded="true" aria-controls="sidebar-content" title="Hide sidebar">‹</button></div>
    <div id="sidebar-content" class="sidebar-content">
    <button class="nav-item active" id="nav-profiles"><span aria-hidden="true">▦</span> Browser profiles <span id="nav-count"></span></button>
    <button class="nav-item" id="nav-viewer" hidden><span aria-hidden="true">▣</span> Active viewer <i class="live-dot"></i></button>
    <div class="profile-nav-heading"><span class="nav-caption">PROFILES</span><button class="icon-button" data-action="create" aria-label="Add profile" title="Add profile">＋</button></div>
    <nav id="profile-nav" class="profile-nav" aria-label="Switch profile"></nav>
    <div class="nav-bottom"><span class="connection-dot"></span><span id="sync-status" role="status">Connecting…</span><button class="icon-button" id="refresh" aria-label="Refresh profiles" title="Refresh profiles">↻</button></div>
    </div>
    <div id="sidebar-resize" class="sidebar-resize" role="separator" tabindex="0" aria-label="Resize sidebar" aria-orientation="vertical" aria-controls="sidebar-content" aria-valuemin="220" aria-valuemax="520" aria-valuenow="280" title="Drag to resize; double-click to reset"></div>
  </aside>
  <div class="workspace">
    <span id="page-context" class="sr-only">Browser profiles</span>
    <main id="profiles-page">
      <div class="page-heading"><h1>Browser profiles</h1><button class="primary" id="create-profile"><span aria-hidden="true">＋</span> New profile</button></div>
      <section class="metrics" aria-label="Workspace summary" id="metrics"></section>
      <div class="profiles-workspace" id="profiles-workspace">
        <section class="profiles-panel" aria-label="Profile list">
          <div class="table-scroll"><table><thead><tr><th>PROFILE</th><th>STATUS</th><th>CONNECTIONS</th><th>MEMORY</th><th>LAST ACTIVE</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody id="profile-rows"></tbody></table></div>
          <div id="empty-state" class="empty-state" hidden></div>
          <footer class="list-footer"><span id="list-total"></span><span>Profiles keep their data when stopped.</span></footer>
        </section>
        <aside id="profile-detail" class="detail-panel" aria-label="Selected profile" hidden></aside>
      </div>
    </main>
    <section id="viewer-page" class="viewer-page" hidden aria-label="Browser viewer">
      <div class="viewer-toolbar"><button id="viewer-back" class="secondary">← Profiles</button><div class="viewer-identity"><strong id="viewer-name"></strong><span id="viewer-id" class="mono"></span></div><span id="viewer-state" class="badge">Connecting</span><div class="viewer-actions"><button class="secondary" data-action="edit">Settings</button><button id="viewer-reconnect" class="secondary">Reconnect</button><button id="viewer-paste" class="secondary" disabled>Paste</button><button id="viewer-copy" class="secondary" disabled>Copy out</button><button id="viewer-fullscreen" class="icon-button" title="Full screen" aria-label="Full screen">⛶</button><button id="viewer-close" class="icon-button" title="Close viewer; browser keeps running" aria-label="Close viewer">×</button></div></div>
      <iframe id="viewer-frame" title="CloakHub browser viewer" allow="clipboard-read; clipboard-write"></iframe>
    </section>
  </div>
</div>
<dialog id="profile-editor" aria-labelledby="editor-title"></dialog>
<dialog id="confirm-dialog" class="confirm-dialog" aria-labelledby="confirm-title"></dialog>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script id="bootstrap" type="application/json">${data}</script><script type="module" src="/assets/app.js"></script>
</body></html>`;
}
