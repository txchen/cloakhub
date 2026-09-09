import type { EventEntry, EventPage } from "../event-log";
import type { PresentedBrowserProfile } from "../profile-presentation";
import { element, escape } from "./dom";
import { request } from "./api";

export function createEventLogController(showProfiles: () => void) {
  const page = element("#events-page");
  const form = element<HTMLFormElement>("#events-filters");
  const rows = element("#event-rows");
  const status = element("#events-status");
  const more = element<HTMLButtonElement>("#events-more");
  let entries: EventEntry[] = [];
  let before: number | null = null;
  let filters = new URLSearchParams();
  let generation = 0;
  let loading = false;
  let browsingHistory = false;

  async function refresh(older = false) {
    if (page.hidden || (older && (before === null || loading))) return;
    const version = ++generation;
    loading = true;
    more.disabled = true;
    status.textContent = "Loading events…";
    const params = new URLSearchParams(filters);
    params.set("limit", "100");
    if (older && before !== null) params.set("before", String(before));
    try {
      const result = await request<EventPage>(`/ui/events?${params}`);
      if (version !== generation) return;
      entries = older ? [...entries, ...result.events] : result.events;
      browsingHistory = older;
      before = result.next_before;
      rows.innerHTML = entries
        .map((event) => {
          const time = new Date(event.occurred_at);
          const details = Object.entries(event.details)
            .map(
              ([key, value]) =>
                `<span><strong>${escape(key.replaceAll("_", " "))}:</strong> ${escape(String(value ?? "—"))}</span>`
            )
            .join("");
          return `<tr><td><time datetime="${escape(event.occurred_at)}" title="${escape(event.occurred_at)}">${escape(time.toLocaleString())}</time></td><td><code>${escape(event.profile_id ?? "CloakHub")}</code></td><td><span class="event-level ${escape(event.level)}">${escape(event.type)}</span><p>${escape(event.message)}</p></td><td class="event-details">${details || "—"}</td></tr>`;
        })
        .join("");
      element("#events-empty").hidden = entries.length > 0;
      more.hidden = before === null;
      status.textContent = `${entries.length} events · newest recorded first · ${browsingHistory ? "Browsing history; refresh to see latest events" : "Updates every 5 seconds"}`;
    } catch (error) {
      if (version === generation)
        status.textContent = `Could not load events: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (version === generation) {
        loading = false;
        more.disabled = false;
      }
    }
  }
  function applyFilters() {
    filters = new URLSearchParams();
    for (const [key, raw] of new FormData(form)) {
      const value = String(raw).trim();
      if (value)
        filters.set(
          key,
          key === "since" || key === "until"
            ? new Date(value).toISOString()
            : value
        );
    }
    browsingHistory = false;
    void refresh();
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    applyFilters();
  };
  form.onreset = () => {
    queueMicrotask(applyFilters);
  };
  more.onclick = () => {
    void refresh(true);
  };
  element("#events-refresh").onclick = () => {
    void refresh();
  };
  element("#nav-events").onclick = () => {
    showProfiles();
    element("#profiles-page").hidden = true;
    element("#viewer-page").hidden = true;
    element("#nav-profiles").classList.remove("active");
    element("#nav-viewer").classList.remove("active");
    element("#nav-events").classList.add("active");
    element("#page-context").textContent = "Event log";
    page.hidden = false;
    void refresh();
  };
  setInterval(() => {
    if (!document.hidden && !page.hidden && !loading && !browsingHistory)
      void refresh();
  }, 5000);
  return {
    hide() {
      page.hidden = true;
      element("#nav-events").classList.remove("active");
      generation++;
      loading = false;
    },
    update(profiles: PresentedBrowserProfile[]) {
      element("#event-profiles").innerHTML = profiles
        .map(
          (profile) =>
            `<option value="${escape(profile.profile_id)}">${escape(profile.display_name)}</option>`
        )
        .join("");
      const active = profiles.filter(
        (profile) => profile.instance_status !== "stopped"
      );
      element("#events-sleep-status").innerHTML = active.length
        ? active
            .map(
              (profile) =>
                `<div><strong>${escape(profile.display_name)}</strong><code>${escape(profile.profile_id)}</code><span>${escape(profile.instance_status === "running" ? profile.sleep_status : profile.instance_status)}</span>${profile.last_activity_at ? `<small>Last activity: ${escape(new Date(profile.last_activity_at).toLocaleString())}</small>` : ""}</div>`
            )
            .join("")
        : "<p>All browsers are stopped.</p>";
    }
  };
}
