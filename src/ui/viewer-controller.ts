import type { PresentedBrowserProfile } from "../profile-presentation";
import { copyText, element, toast } from "./dom";
import { profilePath } from "./api";

export function createViewerController(
  onConnectionChange: () => void,
  onNavigate: (profileId: string | undefined) => void
) {
  const page = element("#viewer-page");
  const profilesPage = element("#profiles-page");
  const frame = element<HTMLIFrameElement>("#viewer-frame");
  const nav = element<HTMLButtonElement>("#nav-viewer");
  const paste = element<HTMLButtonElement>("#viewer-paste");
  const copy = element<HTMLButtonElement>("#viewer-copy");
  const state = element("#viewer-state");
  let active: PresentedBrowserProfile | undefined;
  let connected = false;
  let clipboard = "";
  const setPage = (viewer: boolean) => {
    page.hidden = !viewer;
    profilesPage.hidden = viewer;
    nav.classList.toggle("active", viewer);
    element("#nav-profiles").classList.toggle("active", !viewer);
    element("#page-context").textContent = viewer
      ? active?.display_name ?? "Browser viewer"
      : "Browser profiles";
    onNavigate(viewer ? active?.profile_id : undefined);
  };
  const updateClipboard = () => {
    paste.disabled = !connected || !active?.clipboard_sync;
    copy.disabled = !clipboard || !active?.clipboard_sync;
  };
  const connect = () => {
    if (!active) return;
    connected = false;
    clipboard = "";
    updateClipboard();
    state.textContent = "Connecting…";
    state.className = "badge starting";
    frame.src = `${profilePath(active.profile_id)}/viewer`;
  };
  element("#viewer-back").onclick = () => setPage(false);
  element("#nav-profiles").onclick = () => setPage(false);
  nav.onclick = () => setPage(true);
  element("#viewer-reconnect").onclick = connect;
  const close = () => {
    active = undefined;
    connected = false;
    clipboard = "";
    frame.removeAttribute("src");
    nav.hidden = true;
    setPage(false);
    updateClipboard();
    onConnectionChange();
  };
  element("#viewer-close").onclick = close;
  element("#viewer-fullscreen").onclick = () => {
    void (
      document.fullscreenElement
        ? document.exitFullscreen()
        : page.requestFullscreen()
    ).catch(() => toast("Full screen is unavailable in this browser.", true));
  };
  frame.onload = () => {
    if (!active) return;
    const doc = frame.contentDocument;
    if (doc?.body && !doc.getElementById("manual-viewer")) {
      state.textContent = "Connection failed";
      state.className = "badge failed";
      toast(
        doc.body.innerText.trim().slice(0, 250) ||
          "Could not open the viewer. Try reconnecting.",
        true
      );
      onConnectionChange();
    }
  };
  window.addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow ||
      !active ||
      event.data?.profile_id !== active.profile_id
    )
      return;
    if (event.data.type === "cloakhub-viewer-connected") {
      connected = true;
      state.textContent = "Connected";
      state.className = "badge running";
      updateClipboard();
      onConnectionChange();
    } else if (event.data.type === "cloakhub-viewer-disconnected") {
      connected = false;
      clipboard = "";
      state.textContent = "Disconnected";
      state.className = "badge stopped";
      updateClipboard();
      onConnectionChange();
    } else if (
      event.data.type === "cloakhub-viewer-clipboard" &&
      typeof event.data.text === "string" &&
      active.clipboard_sync
    ) {
      clipboard = event.data.text;
      updateClipboard();
      if (clipboard)
        void copyText(clipboard).catch(() => copy.classList.add("attention"));
    }
  });
  paste.onclick = async () => {
    const id = active?.profile_id;
    const text =
      (await navigator.clipboard?.readText().catch(() => "")) ||
      window.prompt("Paste text to send to the browser") ||
      "";
    if (!text || !id || id !== active?.profile_id || !active.clipboard_sync)
      return;
    frame.contentWindow?.postMessage(
      { type: "cloakhub-viewer-paste", profile_id: id, text },
      location.origin
    );
    frame.focus();
  };
  copy.onclick = () => {
    void copyText(clipboard)
      .then(() => {
        copy.classList.remove("attention");
        toast("Copied to your clipboard");
      })
      .catch((error) => toast(error.message, true));
  };
  return {
    showProfiles() {
      setPage(false);
    },
    open(profile: PresentedBrowserProfile) {
      if (profile.headless) {
        toast(
          "This profile is headless. Use CDP, or change its browser mode in settings."
        );
        return;
      }
      if (active?.profile_id !== profile.profile_id) {
        active = profile;
        connect();
      }
      element("#viewer-name").textContent = profile.display_name;
      element("#viewer-id").textContent = profile.profile_id;
      nav.hidden = false;
      setPage(true);
    },
    update(profiles: PresentedBrowserProfile[]) {
      if (!active) return;
      const updated = profiles.find(
        (profile) => profile.profile_id === active?.profile_id
      );
      if (!updated) {
        close();
        return;
      }
      active = updated;
      element("#viewer-name").textContent = updated.display_name;
      if (!page.hidden)
        element("#page-context").textContent = updated.display_name;
      frame.contentWindow?.postMessage(
        {
          type: "cloakhub-clipboard-preference",
          profile_id: updated.profile_id,
          enabled: updated.clipboard_sync
        },
        location.origin
      );
      updateClipboard();
    }
  };
}
