export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export type InstanceStatus = "failed" | "running" | "starting" | "stopped" | "stopping";
export type StopReason =
  | "capacity preemption"
  | "crash"
  | "idle timeout"
  | "launch failure"
  | "manual stop"
  | "restart";
export type ColorScheme = "light" | "dark" | "system";

export type SleepPolicy =
  | { mode: "default" }
  | { mode: "minutes"; minutes: number }
  | { mode: "never" };

export interface LaunchProfileFields {
  clipboard_sync: boolean;
  color_scheme: ColorScheme;
  custom_launch_args: string[];
  fingerprint_seed: string;
  geoip: string;
  gpu_renderer: string;
  gpu_vendor: string;
  hardware_concurrency: number;
  headless: boolean;
  human_preset: string;
  humanize: boolean;
  locale: string;
  platform: string;
  proxy: string;
  screen_height: number;
  screen_width: number;
  sleep_policy: SleepPolicy;
  timezone: string;
  user_agent: string;
}

export interface BrowserProfile extends LaunchProfileFields {
  cdp_token: string | null;
  created_at: string;
  display_name: string;
  instance_status: InstanceStatus;
  last_activity_at: string | null;
  last_delete_error: string | null;
  last_launch_error: string | null;
  last_launch_failed_at: string | null;
  last_manual_input_at: string | null;
  last_started_at: string | null;
  last_stop_reason: StopReason | null;
  last_stopped_at: string | null;
  notes: string;
  profile_id: string;
  sleep_policy_status: ResolvedSleepPolicy;
  updated_at: string;
}

export type CreateProfileInput = Partial<LaunchProfileFields> & {
  display_name?: string;
  notes?: string;
  profile_id: string;
};

export type UpdateProfileInput = Partial<LaunchProfileFields> & {
  display_name?: string;
  notes?: string;
  profile_id?: string;
};

export interface ResolvedSleepPolicy {
  blocks_sleep: boolean;
  effective_minutes: number | null;
  mode: SleepPolicy["mode"];
}

export const DEFAULT_SLEEP_POLICY_MINUTES = 30;

export type ProfileIdValidationResult =
  | { ok: true; profile_id: string }
  | { error: string; ok: false };

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

export const DEFAULT_LAUNCH_PROFILE_FIELDS: LaunchProfileFields = {
  clipboard_sync: true,
  color_scheme: "system",
  custom_launch_args: [],
  fingerprint_seed: "",
  geoip: "",
  gpu_renderer: "",
  gpu_vendor: "",
  hardware_concurrency: 4,
  headless: false,
  human_preset: "",
  humanize: false,
  locale: "",
  platform: "macos",
  proxy: "",
  screen_height: 768,
  screen_width: 1366,
  sleep_policy: { mode: "default" },
  timezone: "",
  user_agent: ""
};

const CLOAKHUB_OWNED_LAUNCH_FLAGS = [
  "--user-data-dir",
  "--remote-debugging-port",
  "--remote-debugging-address",
  "--remote-debugging-pipe",
  "--window-position",
  "--window-size"
];

export function validateProfileId(value: unknown): ProfileIdValidationResult {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    return {
      error: "Profile ID must match ^[a-z][a-z0-9_]*$",
      ok: false
    };
  }

  return { ok: true, profile_id: value };
}

export function normalizeCreateProfileInput(input: unknown): CreateProfileInput {
  if (!isRecord(input)) {
    throw new ProfileValidationError("Request body must be a JSON object");
  }

  const profileId = validateProfileId(input.profile_id);
  if (!profileId.ok) {
    throw new ProfileValidationError(profileId.error);
  }

  return {
    display_name: optionalString(input.display_name, "display_name") ?? profileId.profile_id,
    notes: optionalString(input.notes, "notes") ?? "",
    profile_id: profileId.profile_id,
    ...normalizeLaunchProfileFields(input, DEFAULT_LAUNCH_PROFILE_FIELDS)
  };
}

export function normalizeUpdateProfileInput(profileId: string, input: unknown): UpdateProfileInput {
  if (!isRecord(input)) {
    throw new ProfileValidationError("Request body must be a JSON object");
  }

  if (input.profile_id !== undefined && input.profile_id !== profileId) {
    throw new ProfileValidationError("Profile ID is immutable");
  }

  return {
    display_name: optionalString(input.display_name, "display_name"),
    notes: optionalString(input.notes, "notes"),
    profile_id: input.profile_id === undefined ? undefined : profileId,
    ...normalizePartialLaunchProfileFields(input)
  };
}

export function maskProxyCredentials(proxy: string): string {
  if (!proxy) {
    return "";
  }

  const parsed = parseProxyUrl(proxy);
  if (!parsed.username && !parsed.password) {
    return proxy;
  }

  const auth = `${parsed.username || "***"}:${parsed.password ? "***" : ""}@`;
  return `${parsed.protocol}//${auth}${parsed.hostname}:${parsed.port}`;
}

export function redactProfileSecretsFromProfile(profile: BrowserProfile): BrowserProfile {
  return {
    ...profile,
    cdp_token: null,
    proxy: maskProxyCredentials(profile.proxy)
  };
}

export function redactProfileSecrets(message: string, cdpTokens: string[] = []): string {
  return redactCdpTokens(message, cdpTokens).replace(
    /((?:https?|socks5):\/\/)([^:\s/@]+):([^@\s]+)@([^:\s/@]+):([0-9]+)/g,
    (_match, scheme: string, username: string, _password: string, hostname: string, port: string) =>
      `${scheme}${username}:***@${hostname}:${port}`
  );
}

export function redactCdpTokens(message: string, cdpTokens: string[] = []): string {
  const queryRedacted = message.replace(/([?&]token=)[^&\s"')]+/g, "$1***");
  return cdpTokens
    .filter((token) => token.length > 0)
    .reduce((redacted, token) => redacted.replaceAll(token, "***"), queryRedacted);
}

export function resolveSleepPolicy(
  sleepPolicy: SleepPolicy,
  globalDefaultMinutes = DEFAULT_SLEEP_POLICY_MINUTES
): ResolvedSleepPolicy {
  if (sleepPolicy.mode === "never") {
    return {
      blocks_sleep: true,
      effective_minutes: null,
      mode: "never"
    };
  }

  if (sleepPolicy.mode === "minutes") {
    return {
      blocks_sleep: false,
      effective_minutes: sleepPolicy.minutes,
      mode: "minutes"
    };
  }

  return {
    blocks_sleep: false,
    effective_minutes: globalDefaultMinutes,
    mode: "default"
  };
}

function normalizeLaunchProfileFields(
  input: Record<string, unknown>,
  defaults: LaunchProfileFields
): LaunchProfileFields {
  return {
    clipboard_sync: optionalBoolean(input.clipboard_sync, "clipboard_sync") ?? defaults.clipboard_sync,
    color_scheme: optionalColorScheme(input.color_scheme) ?? defaults.color_scheme,
    custom_launch_args: optionalLaunchArgs(input.custom_launch_args) ?? defaults.custom_launch_args,
    fingerprint_seed:
      optionalString(input.fingerprint_seed, "fingerprint_seed") ||
      defaults.fingerprint_seed ||
      randomFingerprintSeed(),
    geoip: optionalString(input.geoip, "geoip") ?? defaults.geoip,
    gpu_renderer: optionalString(input.gpu_renderer, "gpu_renderer") ?? defaults.gpu_renderer,
    gpu_vendor: optionalString(input.gpu_vendor, "gpu_vendor") ?? defaults.gpu_vendor,
    hardware_concurrency:
      optionalInteger(input.hardware_concurrency, "hardware_concurrency", 1, 256) ??
      defaults.hardware_concurrency,
    headless: optionalBoolean(input.headless, "headless") ?? defaults.headless,
    human_preset: optionalString(input.human_preset, "human_preset") ?? defaults.human_preset,
    humanize: optionalBoolean(input.humanize, "humanize") ?? defaults.humanize,
    locale: optionalString(input.locale, "locale") ?? defaults.locale,
    platform: optionalString(input.platform, "platform") ?? defaults.platform,
    proxy: optionalProxy(input.proxy) ?? defaults.proxy,
    screen_height:
      optionalInteger(input.screen_height, "screen_height", 100, 10000) ?? defaults.screen_height,
    screen_width: optionalInteger(input.screen_width, "screen_width", 100, 10000) ?? defaults.screen_width,
    sleep_policy: optionalSleepPolicy(input.sleep_policy) ?? defaults.sleep_policy,
    timezone: optionalString(input.timezone, "timezone") ?? defaults.timezone,
    user_agent: optionalString(input.user_agent, "user_agent") ?? defaults.user_agent
  };
}

function normalizePartialLaunchProfileFields(input: Record<string, unknown>): Partial<LaunchProfileFields> {
  const fields: Partial<LaunchProfileFields> = {};

  assignIfPresent(fields, "clipboard_sync", optionalBoolean(input.clipboard_sync, "clipboard_sync"));
  assignIfPresent(fields, "color_scheme", optionalColorScheme(input.color_scheme));
  assignIfPresent(fields, "custom_launch_args", optionalLaunchArgs(input.custom_launch_args));
  assignIfPresent(fields, "fingerprint_seed", optionalString(input.fingerprint_seed, "fingerprint_seed"));
  assignIfPresent(fields, "geoip", optionalString(input.geoip, "geoip"));
  assignIfPresent(fields, "gpu_renderer", optionalString(input.gpu_renderer, "gpu_renderer"));
  assignIfPresent(fields, "gpu_vendor", optionalString(input.gpu_vendor, "gpu_vendor"));
  assignIfPresent(
    fields,
    "hardware_concurrency",
    optionalInteger(input.hardware_concurrency, "hardware_concurrency", 1, 256)
  );
  assignIfPresent(fields, "headless", optionalBoolean(input.headless, "headless"));
  assignIfPresent(fields, "human_preset", optionalString(input.human_preset, "human_preset"));
  assignIfPresent(fields, "humanize", optionalBoolean(input.humanize, "humanize"));
  assignIfPresent(fields, "locale", optionalString(input.locale, "locale"));
  assignIfPresent(fields, "platform", optionalString(input.platform, "platform"));
  assignIfPresent(fields, "proxy", optionalProxy(input.proxy));
  assignIfPresent(fields, "screen_height", optionalInteger(input.screen_height, "screen_height", 100, 10000));
  assignIfPresent(fields, "screen_width", optionalInteger(input.screen_width, "screen_width", 100, 10000));
  assignIfPresent(fields, "sleep_policy", optionalSleepPolicy(input.sleep_policy));
  assignIfPresent(fields, "timezone", optionalString(input.timezone, "timezone"));
  assignIfPresent(fields, "user_agent", optionalString(input.user_agent, "user_agent"));

  return fields;
}

function assignIfPresent<Key extends keyof LaunchProfileFields>(
  fields: Partial<LaunchProfileFields>,
  key: Key,
  value: LaunchProfileFields[Key] | undefined
): void {
  if (value !== undefined) {
    fields[key] = value;
  }
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ProfileValidationError(`${fieldName} must be a string`);
  }

  return value;
}

function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ProfileValidationError(`${fieldName} must be a boolean`);
  }

  return value;
}

function optionalInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProfileValidationError(`${fieldName} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function optionalColorScheme(value: unknown): ColorScheme | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "light" && value !== "dark" && value !== "system") {
    throw new ProfileValidationError("color_scheme must be light, dark, or system");
  }

  return value;
}

function optionalSleepPolicy(value: unknown): SleepPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new ProfileValidationError("sleep_policy.mode must be default, minutes, or never");
  }

  if (value.mode === "default" || value.mode === "never") {
    return { mode: value.mode };
  }

  if (value.mode === "minutes") {
    return {
      mode: "minutes",
      minutes: requiredInteger(value.minutes, "sleep_policy.minutes", 1, 1440)
    };
  }

  throw new ProfileValidationError("sleep_policy.mode must be default, minutes, or never");
}

function requiredInteger(value: unknown, fieldName: string, minimum: number, maximum: number): number {
  const parsed = optionalInteger(value, fieldName, minimum, maximum);
  if (parsed === undefined) {
    throw new ProfileValidationError(`${fieldName} must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}

function optionalProxy(value: unknown): string | undefined {
  const proxy = optionalString(value, "proxy");
  if (proxy === undefined || proxy === "") {
    return proxy;
  }

  return formatProxy(parseProxyUrl(proxy));
}

function parseProxyUrl(proxy: string): {
  hostname: string;
  password: string;
  port: string;
  protocol: "http:" | "https:" | "socks5:";
  username: string;
} {
  if (!proxy.includes("://")) {
    const parts = proxy.split(":");
    if (parts.length === 2) {
      validateProxyHostPort(parts[0], parts[1]);
      return { hostname: parts[0]!, password: "", port: parts[1]!, protocol: "http:", username: "" };
    }

    if (parts.length === 4) {
      validateProxyHostPort(parts[0], parts[1]);
      return {
        hostname: parts[0]!,
        password: parts[3]!,
        port: parts[1]!,
        protocol: "http:",
        username: parts[2]!
      };
    }

    throw new ProfileValidationError("proxy must include a hostname and port");
  }

  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new ProfileValidationError("proxy must be a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "socks5:") {
    throw new ProfileValidationError("proxy scheme must be http, https, or socks5");
  }

  if (!url.hostname || !url.port) {
    throw new ProfileValidationError("proxy must include a hostname and port");
  }

  return {
    hostname: url.hostname,
    password: decodeURIComponent(url.password),
    port: url.port,
    protocol: url.protocol,
    username: decodeURIComponent(url.username)
  };
}

function validateProxyHostPort(hostname: string | undefined, port: string | undefined): void {
  if (!hostname || !port) {
    throw new ProfileValidationError("proxy must include a hostname and port");
  }

  if (!/^[0-9]+$/.test(port)) {
    throw new ProfileValidationError("proxy port must be numeric");
  }
}

function formatProxy(proxy: ReturnType<typeof parseProxyUrl>): string {
  const auth = proxy.username || proxy.password ? `${proxy.username}:${proxy.password}@` : "";
  return `${proxy.protocol}//${auth}${proxy.hostname}:${proxy.port}`;
}

function optionalLaunchArgs(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ProfileValidationError("custom_launch_args must be an array of strings");
  }

  validateCustomLaunchArgs(value);
  return value;
}

export function validateCustomLaunchArgs(value: string[]): void {
  for (const arg of value) {
    const ownedFlag = CLOAKHUB_OWNED_LAUNCH_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (ownedFlag) {
      throw new ProfileValidationError(
        `custom_launch_args cannot include CloakHub-owned flag ${ownedFlag}`
      );
    }
  }
}

function randomFingerprintSeed(): string {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
