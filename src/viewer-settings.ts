import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Hub-wide encoding settings for the live viewer stream. They bound voxl's adaptive
 * H.264 rate control: the stream still drops to near zero on a still screen and
 * backs off on a congested link; these only cap how much it may use.
 */
export interface ViewerStreamSettings {
  /** Bitrate ceiling in kbps. */
  max_kbps: number;
  /** Highest frames per second. */
  framerate: number;
  /** x264 constant rate factor: higher is softer and smaller. */
  crf: number;
}

export type ViewerStreamPreset = "data-saver" | "balanced" | "high";

export const VIEWER_STREAM_PRESETS: Record<ViewerStreamPreset, ViewerStreamSettings> = {
  "data-saver": { max_kbps: 2500, framerate: 30, crf: 28 },
  balanced: { max_kbps: 8000, framerate: 60, crf: 25 },
  high: { max_kbps: 30000, framerate: 60, crf: 23 }
};

export const DEFAULT_VIEWER_STREAM_SETTINGS = VIEWER_STREAM_PRESETS.balanced;

export const VIEWER_STREAM_LIMITS = {
  max_kbps: { min: 300, max: 50000 },
  framerate: { min: 5, max: 60 },
  crf: { min: 16, max: 40 }
} as const;

export class InvalidViewerSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidViewerSettingsError";
  }
}

export interface ViewerSettingsStore {
  get(): ViewerStreamSettings;
  update(input: unknown): Promise<ViewerStreamSettings>;
}

export interface ViewerSettingsStoreOptions {
  dataRoot: string;
  /** Called after a change is saved, to re-encode running streams. */
  onChange?: (settings: ViewerStreamSettings) => Promise<void> | void;
}

export async function openViewerSettingsStore(
  options: ViewerSettingsStoreOptions
): Promise<ViewerSettingsStore> {
  const path = join(options.dataRoot, "viewer-settings.json");
  let current = DEFAULT_VIEWER_STREAM_SETTINGS;
  try {
    current = parseViewerSettings(JSON.parse(await readFile(path, "utf8")));
  } catch {
    /* missing or unreadable: defaults */
  }

  return {
    get: () => current,
    async update(input: unknown): Promise<ViewerStreamSettings> {
      const next = parseViewerSettings(input, current);
      await mkdir(options.dataRoot, { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
      await rename(temporary, path);
      const changed = JSON.stringify(next) !== JSON.stringify(current);
      current = next;
      if (changed) await options.onChange?.(next);
      return next;
    }
  };
}

/** Validates a full or partial settings object, filling gaps from `base`. */
export function parseViewerSettings(
  input: unknown,
  base: ViewerStreamSettings = DEFAULT_VIEWER_STREAM_SETTINGS
): ViewerStreamSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidViewerSettingsError("Viewer settings must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.preset === "string") {
    const preset = VIEWER_STREAM_PRESETS[record.preset as ViewerStreamPreset];
    if (!preset) throw new InvalidViewerSettingsError(`Unknown viewer preset "${record.preset}"`);
    return { ...preset };
  }
  const result = { ...base };
  for (const key of Object.keys(VIEWER_STREAM_LIMITS) as (keyof ViewerStreamSettings)[]) {
    const value = record[key];
    if (value === undefined) continue;
    const { min, max } = VIEWER_STREAM_LIMITS[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new InvalidViewerSettingsError(`${key} must be an integer from ${min} to ${max}`);
    }
    result[key] = value;
  }
  return result;
}

export function viewerPresetFor(settings: ViewerStreamSettings): ViewerStreamPreset | "custom" {
  for (const [name, preset] of Object.entries(VIEWER_STREAM_PRESETS)) {
    if (
      preset.max_kbps === settings.max_kbps &&
      preset.framerate === settings.framerate &&
      preset.crf === settings.crf
    ) {
      return name as ViewerStreamPreset;
    }
  }
  return "custom";
}

/**
 * voxl flags for these settings. voxl's `--max-kbps` is a rate-control target, and
 * x264 may spend up to twice that on a moving frame (more on still-screen
 * sharpening), so it gets half the ceiling to keep measured peaks near `max_kbps`.
 */
export function voxlStreamFlags(settings: ViewerStreamSettings): string[] {
  const targetKbps = Math.ceil(settings.max_kbps / 2);
  const minKbps = Math.min(2000, Math.max(100, Math.floor(targetKbps / 2)));
  return [
    `--max-kbps=${targetKbps}`,
    `--min-kbps=${minKbps}`,
    `--framerate=${settings.framerate}`,
    `--crf=${settings.crf}`
  ];
}
