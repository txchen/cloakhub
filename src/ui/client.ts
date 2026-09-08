import type { PresentedBrowserProfile } from "../profile-presentation";
import {
  element,
  escape,
  toast,
  confirmAction,
  copyText,
  relativeTime,
  memory
} from "./dom";
import { request, profilePath } from "./api";
import { openProfileEditor } from "./profile-editor";
import { createViewerController } from "./viewer-controller";

type Profile = PresentedBrowserProfile;
const bootstrap = JSON.parse(element("#bootstrap").textContent!) as {
  profiles: Profile[];
  limit: number;
};
let profiles = bootstrap.profiles;
let selectedId = "";
let filter = "all";
const busy = new Set<string>();
const rows = element<HTMLTableSectionElement>("#profile-rows");
const detail = element("#profile-detail");
const search = element<HTMLInputElement>("#search");
const sort = element<HTMLSelectElement>("#sort");
const syncStatus = element("#sync-status");
const viewer = createViewerController(() => {
  void refresh(true);
});
const htmlCache = new WeakMap<HTMLElement, string>();
function setHTML(node: HTMLElement, html: string) {
  if (htmlCache.get(node) === html) return;
  const focused = node.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.action
    : undefined;
  node.innerHTML = html;
  htmlCache.set(node, html);
  if (focused)
    node.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus();
}
const statusBadge = (profile: Profile) =>
  `<span class="badge ${escape(profile.instance_status)}"><i></i>${escape(profile.instance_status)}</span>`;
const tags = (profile: Profile) =>
  (profile.tags ?? [])
    .map((tag) => `<span class="tag">${escape(tag)}</span>`)
    .join("");
function action(
  profile: Profile,
  name: string,
  label: string,
  className = "secondary"
) {
  const pending =
    busy.has(profile.profile_id) ||
    ["starting", "stopping"].includes(profile.instance_status);
  const disabled =
    pending ||
    (name === "start" && profile.instance_status === "running") ||
    (name === "stop" && profile.instance_status === "stopped");
  return `<button type="button" class="${className}" data-action="${name}" data-id="${escape(profile.profile_id)}"${disabled ? " disabled" : ""}>${label}</button>`;
}
function renderRows(filtered: Profile[]) {
  // Keep an open actions menu stable while status observations arrive.
  if (rows.querySelector("details[open]")) return;
  const desired = new Set(filtered.map((profile) => profile.profile_id));
  for (const row of Array.from(rows.children))
    if (!desired.has((row as HTMLElement).dataset.id!)) row.remove();
  filtered.forEach((profile, index) => {
    let row = Array.from(rows.children).find(
      (row) => (row as HTMLElement).dataset.id === profile.profile_id
    ) as HTMLTableRowElement | undefined;
    if (!row) {
      row = document.createElement("tr");
      row.dataset.id = profile.profile_id;
    }
    row.classList.toggle("selected", profile.profile_id === selectedId);
    const clients = profile.cdp_session_count + profile.manual_viewer_count;
    setHTML(
      row,
      `<td><button class="profile-name-button" data-action="select" data-id="${escape(profile.profile_id)}" aria-label="Details for ${escape(profile.display_name)}"><span class="avatar hue-${index % 4}">${escape(profile.display_name.slice(0, 2).toUpperCase())}</span><span><strong>${escape(profile.display_name)}</strong><code>${escape(profile.profile_id)}</code></span></button><div class="row-tags">${tags(profile)}</div></td>
      <td>${statusBadge(profile)}<small class="subline" title="${escape(profile.last_activity_at ?? "")}">${relativeTime(profile.last_activity_at)}</small>${!profile.cdp_token_configured ? '<span class="open-access">CDP open</span>' : ""}</td>
      <td><span class="connection-count">${clients ? `${profile.cdp_session_count} CDP <span>·</span> ${profile.manual_viewer_count} viewer` : '<span class="muted">No connections</span>'}</span><small class="subline">${profile.headless ? "Automation only" : "Browser & viewer"}</small></td>
      <td class="memory-cell">${memory(profile.resource_usage.rss_bytes)}</td>
      <td><div class="row-actions">${profile.headless ? action(profile, "start", "Start") : action(profile, "open", "Open ↗")}
        <details class="row-menu"><summary class="icon-button" aria-label="Actions for ${escape(profile.display_name)}" title="Profile actions">···</summary><div class="menu-content">${action(profile, "edit", "Edit settings", "menu-button")}${action(profile, "copy", "Copy CDP URL", "menu-button")}${action(profile, "start", "Start", "menu-button")}${action(profile, "stop", "Stop", "menu-button")}${action(profile, "restart", "Restart", "menu-button")}${action(profile, "delete", "Delete profile", "menu-button text-danger")}</div></details></div></td>`
    );
    if (rows.children[index] !== row)
      rows.insertBefore(row, rows.children[index] ?? null);
  });
}
function renderDetail() {
  const profile = profiles.find((profile) => profile.profile_id === selectedId);
  detail.hidden = !profile;
  element("#profiles-workspace").classList.toggle(
    "has-selection",
    Boolean(profile)
  );
  if (!profile) return;
  const facts = (label: string, value: string) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  setHTML(
    detail,
    `<header class="detail-heading"><span class="eyebrow">PROFILE DETAILS</span><button class="icon-button" data-action="dismiss" aria-label="Close profile details">×</button></header>
    <div class="detail-identity"><span class="avatar large">${escape(profile.display_name.slice(0, 2).toUpperCase())}</span><h2>${escape(profile.display_name)}</h2><code>${escape(profile.profile_id)}</code><div class="detail-badges">${statusBadge(profile)}${tags(profile)}</div></div>
    <div class="detail-actions">${profile.headless ? action(profile, "start", "Start browser", "primary") : action(profile, "open", "Open browser ↗", "primary")}${action(profile, "edit", "Edit settings")}</div>
    ${profile.last_launch_error ? `<div class="error-card"><strong>Last launch error</strong><p>${escape(profile.last_launch_error)}</p></div>` : ""}
    ${profile.last_delete_error ? `<div class="error-card"><strong>Last deletion error</strong><p>${escape(profile.last_delete_error)}</p></div>` : ""}
    <section class="detail-section"><h3>Activity</h3><dl>${facts("Memory", memory(profile.resource_usage.rss_bytes))}${facts("Connections", `${profile.cdp_session_count} CDP · ${profile.manual_viewer_count} viewer`)}${facts("Last activity", relativeTime(profile.last_activity_at))}${facts("Manual input", relativeTime(profile.last_manual_input_at))}${facts("Idle policy", escape(profile.instance_status === "running" ? profile.sleep_status.replace("Sleep Countdown: ", "Stops in ").replace("Sleep Blocker: ", "Kept awake: ") : "Browser is stopped"))}${facts("Last stop", escape(profile.last_stop_reason ?? "—"))}</dl>
    ${profile.cdp_sessions.length ? `<ul class="sessions">${profile.cdp_sessions.map((session) => `<li><span class="live-dot"></span><span>${escape(session.remote_address ?? "Unknown client")}<small>${Math.floor(session.duration_ms / 60000)}m connected · ${escape(session.user_agent ?? "CDP client")}</small></span></li>`).join("")}</ul>` : ""}
    <div class="lifecycle-actions">${action(profile, "stop", "Stop")}${action(profile, "restart", "Restart")}</div></section>
    <section class="detail-section"><h3>Automation access <span class="badge ${profile.cdp_token_configured ? "running" : "open"}">${profile.cdp_token_configured ? "Protected" : "Open"}</span></h3><p>${profile.cdp_token_configured ? "A profile token protects this CDP endpoint." : "Anyone who can reach this server can connect to this profile’s CDP endpoint."}</p><div class="access-actions">${action(profile, "copy", "Copy CDP URL")}${action(profile, profile.cdp_token_configured ? "regenerate-token" : "create-token", profile.cdp_token_configured ? "Regenerate token" : "Protect with token")}${profile.cdp_token_configured ? action(profile, "revoke-token", "Revoke token", "text-button text-danger") : ""}</div></section>
    <section class="detail-section"><h3>Configuration</h3><dl>${facts("Mode", profile.headless ? "Headless" : "Browser with viewer")}${facts("Region", escape([profile.timezone, profile.locale].filter(Boolean).join(" · ") || "Browser default"))}${facts("Proxy", escape(profile.proxy || "Direct connection"))}${facts("Screen", `${profile.screen_width} × ${profile.screen_height}`)}</dl>${profile.notes ? `<p class="profile-notes">${escape(profile.notes)}</p>` : ""}</section>
    <footer class="detail-footer">${action(profile, "delete", "Delete profile", "text-button text-danger")}</footer>`
  );
}
function render() {
  const running = profiles.filter(
    (profile) => profile.instance_status === "running"
  ).length;
  const cdp = profiles.reduce(
    (sum, profile) => sum + profile.cdp_session_count,
    0
  );
  const memoryValues = profiles
    .map((profile) => profile.resource_usage.rss_bytes)
    .filter((value): value is number => value !== null);
  setHTML(
    element("#metrics"),
    `<div class="metric"><span>Total profiles</span><strong>${profiles.length}<small>persistent identities</small></strong></div><div class="metric"><span><i class="live-dot"></i> Running now</span><strong>${running}<small>/ ${bootstrap.limit} capacity</small></strong></div><div class="metric"><span>Automation connections</span><strong>${cdp}<small>active CDP sessions</small></strong></div><div class="metric"><span>Browser memory</span><strong>${memory(memoryValues.length ? memoryValues.reduce((a, b) => a + b, 0) : null)}<small>approx. RSS</small></strong></div>`
  );
  element("#nav-count").textContent = String(profiles.length);
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = profiles.filter(
    (profile) =>
      (filter === "all" || profile.instance_status === filter) &&
      [profile.display_name, profile.profile_id, ...(profile.tags ?? [])].some(
        (value) => value.toLocaleLowerCase().includes(query)
      )
  );
  const rank: Record<string, number> = {
    failed: 0,
    starting: 1,
    running: 2,
    stopping: 3,
    stopped: 4
  };
  filtered.sort(
    (a, b) =>
      (sort.value === "name"
        ? a.display_name.localeCompare(b.display_name)
        : sort.value === "status"
          ? rank[a.instance_status]! - rank[b.instance_status]!
          : (Date.parse(b.last_activity_at ?? "") || 0) -
            (Date.parse(a.last_activity_at ?? "") || 0)) ||
      a.profile_id.localeCompare(b.profile_id)
  );
  renderRows(filtered);
  renderDetail();
  const empty = element("#empty-state");
  empty.hidden = filtered.length > 0;
  setHTML(
    empty,
    profiles.length
      ? `<span class="empty-icon">⌕</span><h2>No matching profiles</h2><p>Try another name or tag, or clear your filters.</p><button class="secondary" data-action="reset">Clear filters</button>`
      : `<span class="empty-icon">▦</span><h2>Your workspace starts here</h2><p>Create a browser profile to keep its identity, cookies, and settings together.</p><button class="primary" data-action="create">Create your first profile</button>`
  );
  element("#result-count").textContent = `${filtered.length} shown`;
  element("#list-total").textContent =
    `${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"}`;
  viewer.update(profiles);
}
let inFlight: Promise<void> | undefined;
async function refresh(force = false): Promise<void> {
  if (inFlight) {
    await inFlight;
    if (!force) return;
  }
  if (document.hidden && !force) return;
  const task = (async () => {
    try {
      profiles = await request<Profile[]>("/ui/profiles");
      syncStatus.textContent = "Live · synced just now";
      syncStatus.parentElement!.classList.remove("offline");
      render();
    } catch (error) {
      syncStatus.textContent = "Offline · retrying";
      syncStatus.parentElement!.classList.add("offline");
      if (force)
        toast(error instanceof Error ? error.message : String(error), true);
    }
  })();
  inFlight = task;
  await task;
  if (inFlight === task) inFlight = undefined;
}
function create() {
  openProfileEditor(undefined, async (id) => {
    selectedId = id;
    filter = "all";
    search.value = "";
    updateFilters();
    await refresh(true);
  });
}
function updateFilters() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-filter]")
    .forEach((button) => {
      const active = button.dataset.filter === filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
}
async function perform(name: string, id: string) {
  if (name === "dismiss") {
    selectedId = "";
    render();
    return;
  }
  if (name === "create") {
    create();
    return;
  }
  if (name === "reset") {
    filter = "all";
    search.value = "";
    updateFilters();
    render();
    return;
  }
  const profile = profiles.find((profile) => profile.profile_id === id);
  if (!profile) return;
  if (name === "select") {
    selectedId = id;
    render();
    return;
  }
  if (name === "open") {
    viewer.open(profile);
    return;
  }
  if (name === "edit") {
    openProfileEditor(profile, async () => {
      await refresh(true);
    });
    return;
  }
  if (busy.has(id)) return;
  busy.add(id);
  try {
    if (
      name === "delete" &&
      !(await confirmAction(
        `Delete ${profile.display_name}?`,
        "This stops the browser and permanently removes its cookies, browser data, and settings. This cannot be undone.",
        "Delete profile",
        true
      ))
    )
      return;
    if (
      ["stop", "restart"].includes(name) &&
      profile.cdp_session_count + profile.manual_viewer_count > 0 &&
      !(await confirmAction(
        `${name === "stop" ? "Stop" : "Restart"} this browser?`,
        "Active automation connections and viewers will be disconnected.",
        name === "stop" ? "Stop browser" : "Restart browser",
        true
      ))
    )
      return;
    if (name === "copy") {
      let url = `${location.origin}/api/profiles/${encodeURIComponent(id)}/cdp/json/version`;
      if (profile.cdp_token_configured) {
        if (
          !(await confirmAction(
            "Copy a URL containing your token?",
            "Anyone with this URL can access this browser. Share it only with trusted automation clients.",
            "Copy URL"
          ))
        )
          return;
        const token = await request<{ cdp_token: string }>(
          `${profilePath(id)}/cdp-token`
        );
        url += `?token=${encodeURIComponent(token.cdp_token)}`;
      }
      await copyText(url);
      toast("CDP URL copied");
      return;
    }
    if (
      ["regenerate-token", "revoke-token"].includes(name) &&
      !(await confirmAction(
        name === "revoke-token"
          ? "Remove CDP protection?"
          : "Replace this token?",
        name === "revoke-token"
          ? "The CDP endpoint will be open to anyone who can reach this server."
          : "Clients will need the new token for future connections.",
        name === "revoke-token" ? "Revoke token" : "Regenerate token",
        true
      ))
    )
      return;
    render();
    if (name.endsWith("-token"))
      await request(
        `${profilePath(id)}/cdp-token${name === "regenerate-token" ? "/regenerate" : ""}`,
        name === "revoke-token" ? "DELETE" : "POST"
      );
    else if (name === "delete") await request(profilePath(id), "DELETE");
    else await request(`${profilePath(id)}/${name}`, "POST");
    toast(
      name === "delete"
        ? "Profile deleted"
        : name.endsWith("-token")
          ? "CDP access updated"
          : `${profile.display_name}: ${name === "stop" ? "stopped" : "running"}`
    );
    await refresh(true);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  } finally {
    busy.delete(id);
    render();
  }
}
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const actionButton = target.closest<HTMLElement>("[data-action]");
  if (actionButton && !(actionButton as HTMLButtonElement).disabled) {
    rows
      .querySelectorAll<HTMLDetailsElement>("details[open]")
      .forEach((menu) => (menu.open = false));
    void perform(
      actionButton.dataset.action!,
      actionButton.dataset.id ?? selectedId
    );
  }
  if (!target.closest(".row-menu"))
    rows
      .querySelectorAll<HTMLDetailsElement>("details[open]")
      .forEach((menu) => (menu.open = false));
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !(event.target instanceof HTMLInputElement) &&
    !(event.target instanceof HTMLTextAreaElement) &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    search.focus();
  }
  if (event.key === "Escape")
    rows
      .querySelectorAll<HTMLDetailsElement>("details[open]")
      .forEach((menu) => (menu.open = false));
});
search.oninput = render;
sort.onchange = render;
element("#create-profile").onclick = create;
element("#refresh").onclick = () => {
  void refresh(true);
};
document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach(
  (button) =>
    (button.onclick = () => {
      filter = button.dataset.filter!;
      updateFilters();
      render();
    })
);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
render();
void refresh();
setInterval(() => {
  void refresh();
}, 2500);
