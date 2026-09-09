import type { PresentedBrowserProfile } from "../profile-presentation";
import { element, escape } from "./dom";

/** Keep profile positions and keyboard focus stable as live observations arrive. */
export function createProfileNavigation() {
  const list = element("#profile-nav");
  const buttons = new Map<string, HTMLButtonElement>();
  const empty = document.createElement("p");
  empty.className = "profile-nav-empty";
  list.append(empty);
  let profiles: PresentedBrowserProfile[] = [];
  let selectedId = "";

  function render() {
    const ordered = [...profiles].sort((a, b) =>
        a.display_name.localeCompare(b.display_name) ||
        a.profile_id.localeCompare(b.profile_id)
      );
    const ids = new Set(ordered.map((profile) => profile.profile_id));
    for (const [id, button] of buttons) {
      if (!ids.has(id)) {
        button.remove();
        buttons.delete(id);
      }
    }
    ordered.forEach((profile, index) => {
      let button = buttons.get(profile.profile_id);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "profile-nav-item";
        button.dataset.action = "switch";
        button.dataset.id = profile.profile_id;
        buttons.set(profile.profile_id, button);
      }
      const selected = profile.profile_id === selectedId;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      button.setAttribute("aria-label", `Switch to ${profile.display_name}`);
      button.title = `${profile.display_name} · ${profile.profile_id} · ${profile.instance_status}${profile.headless ? " · Headless" : ""}`;
      const html = `<span class="profile-nav-status ${escape(profile.instance_status)}" aria-hidden="true"></span><span class="profile-nav-label"><strong>${escape(profile.display_name)}</strong><small>${escape(profile.instance_status)}</small></span><span class="profile-nav-mode" aria-hidden="true">${profile.headless ? "⌘" : "▣"}</span>`;
      if (button.innerHTML !== html) button.innerHTML = html;
      if (list.children[index] !== button)
        list.insertBefore(button, list.children[index] ?? empty);
    });
    empty.hidden = profiles.length > 0;
    empty.textContent = "Your profiles will appear here.";
  }

  return {
    update(next: PresentedBrowserProfile[], selected: string) {
      profiles = next;
      selectedId = selected;
      render();
    }
  };
}
