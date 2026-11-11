import { request } from "./api";
import { element, escape, toast } from "./dom";

interface StreamSettings {
  max_kbps: number;
  framerate: number;
  crf: number;
}
interface StreamSettingsResponse {
  settings: StreamSettings;
  preset: string;
  presets: Record<string, StreamSettings>;
  limits: Record<keyof StreamSettings, { min: number; max: number }>;
}

const PATH = "/ui/viewer-settings";
const describe = (s: StreamSettings) =>
  `up to ${s.max_kbps >= 1000 ? `${+(s.max_kbps / 1000).toFixed(1)} Mbps` : `${s.max_kbps} kbps`} · ${s.framerate} fps · quality ${s.crf}`;

/** Hub-wide stream quality: the select in the viewer toolbar and its custom dialog. */
export function setupStreamQuality() {
  const select = element<HTMLSelectElement>("#viewer-quality");
  const dialog = element<HTMLDialogElement>("#quality-dialog");
  let state: StreamSettingsResponse | undefined;

  const show = (next: StreamSettingsResponse) => {
    state = next;
    select.value = next.preset;
    select.title = `Stream quality for all viewers: ${describe(next.settings)}`;
    for (const option of select.options) {
      const preset = next.presets[option.value];
      if (preset) option.title = describe(preset);
    }
  };
  const save = async (body: unknown) => {
    select.disabled = true;
    try {
      show(await request<StreamSettingsResponse>(PATH, "PUT", body));
      toast(`Stream quality updated: ${describe(state!.settings)}`);
    } catch (error) {
      if (state) select.value = state.preset;
      toast((error as Error).message, true);
    } finally {
      select.disabled = false;
    }
  };
  const openCustom = () => {
    if (!state) return;
    const { settings, limits } = state;
    const field = (name: keyof StreamSettings, label: string, hint: string) =>
      `<label class="field"><span>${escape(label)}</span><input name="${name}" type="number" required step="1" min="${limits[name].min}" max="${limits[name].max}" value="${settings[name]}"><small>${escape(hint)}</small></label>`;
    dialog.innerHTML = `<form method="dialog"><h2 id="quality-title">Custom stream quality</h2><p>Applies to every viewer. Open viewers reconnect for a moment.</p>${field("max_kbps", "Bitrate ceiling (kbps)", "The stream uses less on quiet screens and slow links.")}${field("framerate", "Frame rate (fps)", "Lower halves motion bandwidth.")}${field("crf", "Quality (CRF)", "Higher is softer and smaller; 23 sharp, 28 economical.")}<div class="dialog-actions"><button value="cancel" class="secondary" formnovalidate>Cancel</button><button value="save" class="primary">Apply</button></div></form>`;
    dialog.returnValue = "cancel";
    dialog.showModal();
    dialog.addEventListener(
      "close",
      () => {
        const form = dialog.querySelector("form")!;
        if (dialog.returnValue !== "save") {
          select.value = state!.preset;
          return;
        }
        const data = new FormData(form);
        void save({
          max_kbps: Number(data.get("max_kbps")),
          framerate: Number(data.get("framerate")),
          crf: Number(data.get("crf"))
        });
      },
      { once: true }
    );
  };

  select.addEventListener("change", () => {
    if (select.value === "custom") openCustom();
    else void save({ preset: select.value });
  });
  element<HTMLButtonElement>("#viewer-quality-edit").addEventListener("click", openCustom);
  void request<StreamSettingsResponse>(PATH)
    .then(show)
    .catch(() => (select.disabled = true));
}

export function formatStreamStats(fps: number, kbps: number): string {
  const rate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
  return `${Math.round(fps)} fps · ${rate}`;
}
