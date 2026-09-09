import type { PresentedBrowserProfile } from "../profile-presentation";
import type { LaunchProfileFields } from "../profile";
import { element, escape, toast } from "./dom";
import { profilePath, request } from "./api";

let editorRequestId = 0;

export async function openProfileEditor(
  profile: PresentedBrowserProfile | undefined,
  saved: (id: string) => Promise<void>
): Promise<void> {
  const requestId = ++editorRequestId;
  const dialog = element<HTMLDialogElement>("#profile-editor");
  let values: LaunchProfileFields;
  try {
    values = profile ?? await request<LaunchProfileFields>("/ui/profile-defaults");
  } catch (error) {
    if (requestId === editorRequestId) {
      toast(error instanceof Error ? error.message : "Unable to load profile defaults");
    }
    return;
  }
  if (requestId !== editorRequestId) return;
  const edit = Boolean(profile);
  const field = (
    name: string,
    title: string,
    value: unknown,
    hint = "",
    attrs = ""
  ) =>
    `<label class="field"><span>${title}</span><input name="${name}" aria-label="${title}" value="${escape(value)}" ${attrs}>${hint ? `<small>${hint}</small>` : ""}</label>`;
  const select = (
    name: string,
    title: string,
    current: unknown,
    choices: Array<[string, string]>,
    hint = ""
  ) =>
    `<label class="field"><span>${title}</span><select name="${name}" aria-label="${title}">${choices.map(([value, label]) => `<option value="${value}"${String(current) === value ? " selected" : ""}>${label}</option>`).join("")}</select>${hint ? `<small>${hint}</small>` : ""}</label>`;
  const unsupported =
    profile && (profile.geoip || profile.humanize || profile.human_preset);
  dialog.innerHTML = `<form id="editor-form">
    <header class="dialog-heading"><div><p class="eyebrow">${edit ? "PROFILE SETTINGS" : "A NEW BROWSER IDENTITY"}</p><h2 id="editor-title">${edit ? "Edit profile" : "Create profile"}</h2></div><button type="button" data-close class="icon-button" aria-label="Close editor">×</button></header>
    <nav class="editor-tabs" aria-label="Profile settings sections" role="tablist">${["Basics", "Browser", "Fingerprint", "Advanced"].map((tab, i) => `<button type="button" role="tab" id="tab-${i}" aria-controls="panel-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${i}" class="${i === 0 ? "active" : ""}">${tab}</button>`).join("")}</nav>
    <div id="form-error" class="form-error" role="alert" hidden></div>
    ${edit && profile!.instance_status === "running" ? `<p class="editor-notice">Browser settings apply on the next restart. Saving keeps your current viewer connected.</p>` : ""}
    <div class="editor-body">
      <section id="panel-0" role="tabpanel" aria-labelledby="tab-0" data-panel="0"><h3>Make it yours</h3><p class="section-description">Give this browser a name and a purpose. You can fine-tune the rest later.</p><div class="fields">
        ${field("display_name", "Profile name", profile?.display_name ?? "", "A recognizable name in your workspace.", 'placeholder="e.g. Research · US" autocomplete="off"')}
        ${field("profile_id", "Profile ID", profile?.profile_id ?? "", edit ? "Permanent ID used in connections and storage." : "Lower-case letters, numbers, underscores. Starts with a letter.", `pattern="[a-z][a-z0-9_]*" ${edit ? "disabled" : "required"} placeholder="research_us" autocomplete="off"`)}
        ${field("proxy", "Proxy", "", edit && profile?.proxy ? `Current: ${escape(profile.proxy)}. Leave blank to keep it.` : "Optional. HTTP, HTTPS, or SOCKS5 proxy.", 'type="password" autocomplete="new-password" placeholder="http://user:password@host:port"')}
        ${profile?.proxy ? '<label class="checkbox full"><input name="remove_proxy" type="checkbox"> Remove the current proxy</label>' : ""}
        <label class="field full"><span>Notes</span><textarea name="notes" rows="3" placeholder="Purpose, owner, or a reminder for next time…">${escape(profile?.notes ?? "")}</textarea></label>
      </div></section>
      <section id="panel-1" role="tabpanel" aria-labelledby="tab-1" data-panel="1" hidden><h3>How this browser runs</h3><p class="section-description">Choose manual access or automation, and when to reclaim resources.</p><div class="fields">
        ${select(
          "headless",
          "Browser mode",
          values.headless,
          [
            ["false", "Browser with viewer"],
            ["true", "Headless · automation only"]
          ],
          "Browser with viewer also supports unattended CDP automation. Headless has no viewer and may have limited graphics support."
        )}
        ${select(
          "clipboard_sync",
          "Clipboard sync",
          values.clipboard_sync,
          [
            ["true", "Enabled"],
            ["false", "Disabled"]
          ],
          "Transfer text between your computer and the browser. Fully applies on the next start."
        )}
        ${select(
          "sleep_policy_mode",
          "Stop when idle",
          values.sleep_policy.mode,
          [
            ["default", "After 30 minutes · default"],
            ["minutes", "After a custom interval"],
            ["never", "Never automatically"]
          ]
        )}
        ${field("sleep_policy_minutes", "Idle interval (minutes)", values.sleep_policy.mode === "minutes" ? values.sleep_policy.minutes : 30, "Used with a custom interval.", 'type="number" min="1" max="1440"')}
        ${select("color_scheme", "Website appearance", values.color_scheme, [
          ["system", "System default"],
          ["light", "Light"],
          ["dark", "Dark"]
        ])}
      </div><p class="inline-note">An open automation connection keeps the browser running. Watching the viewer without interacting does not.</p></section>
      <section id="panel-2" role="tabpanel" aria-labelledby="tab-2" data-panel="2" hidden><h3>Region & device</h3><p class="section-description">Keep a consistent identity across browser restarts.</p><div class="fields">
        ${field("timezone", "Timezone", values.timezone, "Match the browser’s internet exit region. Saved with this identity; blank inherits the browser environment.", 'placeholder="America/Los_Angeles"')}
        ${field("locale", "Language / locale", values.locale, "A saved language tag such as en-US or zh-CN; blank uses the browser environment.", 'placeholder="en-US"')}
        <p class="inline-note full" id="region-preview"></p>
        <button type="button" class="secondary" data-region-defaults>Use deployment region</button>
        ${select("platform", "Platform", values.platform, [
          ["linux", "Linux · recommended for this server"],
          ["macos", "macOS"],
          ["windows", "Windows"]
        ], "Cross-platform identities need matching fonts and graphics. Changing platform changes this browser’s identity.")}
        ${field("hardware_concurrency", "CPU threads", values.hardware_concurrency, "", 'type="number" min="1" max="256" required')}
        ${field("screen_width", "Screen width", values.screen_width, "Pixels", 'type="number" min="100" max="10000" required')}
        ${field("screen_height", "Screen height", values.screen_height, "Pixels", 'type="number" min="100" max="10000" required')}
      </div></section>
      <section id="panel-3" role="tabpanel" aria-labelledby="tab-3" data-panel="3" hidden><h3>Advanced settings</h3><p class="section-description">Leave these defaults unless you need a specific browser fingerprint.</p><div class="fields">
        ${field("fingerprint_seed", "Fingerprint seed", values.fingerprint_seed, "A stable seed is generated when left blank.")}
        ${field("user_agent", "User agent", values.user_agent)}
        ${field("gpu_vendor", "GPU vendor", values.gpu_vendor)}
        ${field("gpu_renderer", "GPU renderer", values.gpu_renderer)}
        <label class="field full"><span>Custom launch arguments</span><textarea name="custom_launch_args" rows="3" placeholder="--flag=value">${escape(values.custom_launch_args.join("\n"))}</textarea><small>One argument per line. Profile storage and CDP settings are managed by CloakHub.</small></label>
      </div>
      ${unsupported ? '<label class="checkbox warning"><input name="clear_unsupported" type="checkbox"> Remove previously saved GeoIP / Humanize settings so this profile can start.</label>' : ""}</section>
    </div>
    <footer class="dialog-actions"><button type="button" data-close class="secondary">Cancel</button><button type="submit" class="primary">${edit ? "Save changes" : "Create profile"}</button></footer>
  </form>`;
  const form = element<HTMLFormElement>("form", dialog);
  const submit = element<HTMLButtonElement>('[type="submit"]', form);
  let submitting = false;
  let loadingRegion = false;
  let dirty = false;
  const timezone = element<HTMLInputElement>('[name="timezone"]', form);
  const locale = element<HTMLInputElement>('[name="locale"]', form);
  const previewRegion = () => {
    element("#region-preview", form).textContent =
      `Saved region: ${timezone.value || "inherited timezone (not pinned)"} · ${locale.value || "inherited language (not pinned)"}`;
  };
  timezone.addEventListener("input", previewRegion);
  locale.addEventListener("input", previewRegion);
  previewRegion();
  const regionButton = element<HTMLButtonElement>("[data-region-defaults]", form);
  regionButton.onclick = async () => {
    if (submitting || loadingRegion) return;
    loadingRegion = true;
    regionButton.disabled = true;
    submit.disabled = true;
    try {
      const defaults = await request<LaunchProfileFields>("/ui/profile-defaults");
      timezone.value = defaults.timezone;
      locale.value = defaults.locale;
      dirty = true;
      previewRegion();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Unable to load deployment region");
    } finally {
      loadingRegion = false;
      regionButton.disabled = submitting;
      submit.disabled = submitting;
    }
  };
  const switchTab = (index: string) => {
    form
      .querySelectorAll<HTMLElement>("[data-panel]")
      .forEach((panel) => (panel.hidden = panel.dataset.panel !== index));
    form.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
      const selected = button.dataset.tab === index;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  };
  form.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.onclick = () => switchTab(button.dataset.tab!);
    button.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? 3
            : (Number(button.dataset.tab) +
                (event.key === "ArrowLeft" ? 3 : 1)) %
              4;
      switchTab(String(next));
      element<HTMLButtonElement>(`[data-tab="${next}"]`, form).focus();
    };
  });
  form.addEventListener(
    "invalid",
    (event) => {
      const panel = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-panel]"
      );
      if (panel) switchTab(panel.dataset.panel!);
    },
    true
  );
  const close = () => {
    if (
      !submitting &&
      (!dirty || window.confirm("Discard your unsaved changes?"))
    )
      dialog.close();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };
  form
    .querySelectorAll<HTMLButtonElement>("[data-close]")
    .forEach((button) => (button.onclick = close));
  form.addEventListener("input", () => {
    dirty = true;
  });
  const name = element<HTMLInputElement>('[name="display_name"]', form);
  const id = element<HTMLInputElement>('[name="profile_id"]', form);
  let idEdited = edit;
  id.oninput = () => {
    idEdited = true;
  };
  name.oninput = () => {
    if (!idEdited)
      id.value = name.value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/^[^a-z]+/, "");
  };
  const policy = element<HTMLSelectElement>('[name="sleep_policy_mode"]', form);
  const interval = element<HTMLInputElement>(
    '[name="sleep_policy_minutes"]',
    form
  );
  policy.onchange = () => {
    interval.disabled = policy.value !== "minutes";
  };
  interval.disabled = policy.value !== "minutes";
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submitting || loadingRegion) return;
    const body: Record<string, unknown> = Object.fromEntries(
      new FormData(form)
    );
    for (const key of ["headless", "clipboard_sync"])
      body[key] = body[key] === "true";
    for (const key of ["screen_width", "screen_height", "hardware_concurrency"])
      body[key] = Number(body[key]);
    body.custom_launch_args = String(body.custom_launch_args)
      .split(/\r?\n/)
      .map((arg) => arg.trim())
      .filter(Boolean);
    body.sleep_policy =
      body.sleep_policy_mode === "minutes"
        ? { mode: "minutes", minutes: Number(body.sleep_policy_minutes) }
        : { mode: body.sleep_policy_mode };
    delete body.sleep_policy_mode;
    delete body.sleep_policy_minutes;
    if (edit && !body.proxy && !body.remove_proxy) delete body.proxy;
    if (body.remove_proxy) body.proxy = "";
    if (body.clear_unsupported)
      Object.assign(body, { geoip: "", humanize: false, human_preset: "" });
    delete body.remove_proxy;
    delete body.clear_unsupported;
    const error = element("#form-error", form);
    error.hidden = true;
    submitting = true;
    regionButton.disabled = true;
    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      const updated = await request<PresentedBrowserProfile>(
        profile ? profilePath(profile.profile_id) : "/ui/profiles",
        edit ? "PATCH" : "POST",
        body
      );
      dialog.close();
      toast(
        edit
          ? "Profile saved. Browser changes apply on the next start."
          : "Profile created. Open it whenever you’re ready."
      );
      await saved(updated.profile_id);
    } catch (cause) {
      error.textContent =
        cause instanceof Error ? cause.message : String(cause);
      error.hidden = false;
      error.scrollIntoView({ block: "nearest" });
    } finally {
      submitting = false;
      regionButton.disabled = false;
      submit.disabled = false;
      submit.textContent = edit ? "Save changes" : "Create profile";
    }
  };
  dialog.showModal();
}
