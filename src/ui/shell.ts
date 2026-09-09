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
    <button class="nav-item" id="nav-events"><span aria-hidden="true">≡</span> Event log</button>
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
    <main id="events-page" hidden>
      <div class="page-heading"><h1>Event log</h1><button class="secondary" id="events-refresh">Refresh events</button></div>
      <p class="events-intro">Browser lifecycle and automatic sleep history. Times are shown in your local timezone. The latest 100,000 events are retained, including events for deleted profiles.</p>
      <form id="events-filters" class="events-filters">
        <label>Profile ID<input name="profile_id" placeholder="All profiles" list="event-profiles"></label><datalist id="event-profiles"></datalist>
        <label>Event type<select name="type"><option value="">All events</option><option value="sleep.timeout">Idle timeout</option><option value="browser.stopped">Browser stopped</option><option value="sleep.blocked">Sleep blocked</option><option value="sleep.countdown">Sleep countdown</option><option value="browser.stop_failed">Stop failed</option><option value="browser.start_failed">Start failed</option><option value="browser.started">Browser started</option><option value="cdp.connected">CDP connected</option><option value="cdp.disconnected">CDP disconnected</option><option value="tab.protected">Last tab protected</option></select></label>
        <label>From<input name="since" type="datetime-local" step="1"></label>
        <label>Until<input name="until" type="datetime-local" step="1"></label>
        <button class="primary" type="submit">Apply filters</button><button class="secondary" type="reset">Reset</button>
      </form>
      <section class="events-sleep" aria-label="Current automatic sleep status"><h2>Automatic sleep now</h2><p>Open CDP connections prevent automatic sleep. Passive viewing and this event log do not. Idle checks run every 5 seconds.</p><div id="events-sleep-status"></div></section>
      <p id="events-status" role="status" aria-live="polite"></p>
      <section class="profiles-panel" aria-label="Event history"><div class="table-scroll"><table class="events-table"><thead><tr><th>TIME</th><th>PROFILE</th><th>EVENT</th><th>DETAILS</th></tr></thead><tbody id="event-rows"></tbody></table></div><div id="events-empty" class="empty-state" hidden>No events match these filters. History begins when event logging is enabled.</div></section>
      <button class="secondary" id="events-more" hidden>Load older events</button>
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
