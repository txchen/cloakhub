import { join } from "node:path";
import type { CloakHubConfig } from "./config";
import type {
  BrowserRuntime,
  BrowserRuntimeCdpSessionObservation
} from "./browser-runtime";
import {
  redactProfileSecrets,
  redactProfileSecretsFromProfile,
  type BrowserProfile
} from "./profile";
import {
  ownedProcessResourceUsageByProfile,
  type OwnedProcessResourceUsage
} from "./owned-process";

export type PresentedBrowserProfile = Omit<BrowserProfile, "cdp_token"> & {
  cdp_token_configured: boolean;
  cdp_session_count: number;
  cdp_session_labels: string[];
  cdp_sessions: BrowserRuntimeCdpSessionObservation[];
  last_manual_input_at: string | null;
  manual_viewer_count: number;
  profile_data_dir: string;
  resource_usage: OwnedProcessResourceUsage;
  resource_usage_label: string;
  sleep_policy_label: string;
  sleep_status: string;
};

// Agent discovery does not need launch settings, UI labels, or a process scan.
export function profileSummary(profile: BrowserProfile, runtime?: BrowserRuntime) {
  return {
    profile_id: profile.profile_id,
    display_name: profile.display_name,
    notes: profile.notes,
    headless: profile.headless,
    instance_status: profile.instance_status,
    cdp_session_count: runtime?.activeCdpSessionCount(profile.profile_id) ?? 0,
    manual_viewer_count: runtime?.activeManualViewerCount(profile.profile_id) ?? 0,
    last_launch_error: profile.last_launch_error
      ? redactProfileSecrets(profile.last_launch_error, profile.cdp_token ? [profile.cdp_token] : [])
      : null
  };
}

function timestampMs(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function profileResponseProfiles(
  profiles: BrowserProfile[],
  url: URL,
  config: CloakHubConfig,
  browserRuntime: BrowserRuntime | undefined
): Promise<PresentedBrowserProfile[]> {
  const resourceUsageByProfileId = await ownedProcessResourceUsageByProfile(
    config.dataRoot,
    profiles.map((profile) => profile.profile_id)
  );
  return profiles.map((profile) =>
    presentProfileWithResourceUsage(
      profile,
      config.dataRoot,
      resourceUsageByProfileId.get(profile.profile_id),
      browserRuntime,
      url.pathname.startsWith("/ui/")
    )
  );
}

export async function profileResponseProfile(
  profile: BrowserProfile,
  url: URL,
  config: CloakHubConfig,
  browserRuntime: BrowserRuntime | undefined
): Promise<PresentedBrowserProfile> {
  const resourceUsageByProfileId = await ownedProcessResourceUsageByProfile(
    config.dataRoot,
    [profile.profile_id]
  );
  return presentProfileWithResourceUsage(
    profile,
    config.dataRoot,
    resourceUsageByProfileId.get(profile.profile_id),
    browserRuntime,
    url.pathname.startsWith("/ui/")
  );
}

function presentProfile(
  profile: BrowserProfile,
  dataRoot: string,
  browserRuntime: BrowserRuntime | undefined,
  redactSecrets = false
): PresentedBrowserProfile {
  const { cdp_token: _cdpToken, ...profileWithoutToken } = redactSecrets
    ? redactProfileSecretsFromProfile(profile)
    : profile;
  const cdpSessions =
    browserRuntime?.cdpSessionObservations(profile.profile_id) ?? [];
  const presented = {
    ...profileWithoutToken,
    last_launch_error: profile.last_launch_error
      ? redactProfileSecrets(
          profile.last_launch_error,
          profile.cdp_token ? [profile.cdp_token] : []
        )
      : null,
    last_delete_error: profile.last_delete_error
      ? redactProfileSecrets(
          profile.last_delete_error,
          profile.cdp_token ? [profile.cdp_token] : []
        )
      : null,
    cdp_token_configured: Boolean(profile.cdp_token),
    cdp_session_count:
      browserRuntime?.activeCdpSessionCount(profile.profile_id) ?? 0,
    cdp_session_labels: cdpSessions.map(cdpSessionLabel),
    cdp_sessions: cdpSessions,
    last_manual_input_at:
      browserRuntime?.lastManualInputAt(profile.profile_id) ?? null,
    manual_viewer_count:
      browserRuntime?.activeManualViewerCount(profile.profile_id) ?? 0,
    profile_data_dir: profileDataDir(dataRoot, profile.profile_id),
    resource_usage: { owned_process_count: 0, rss_bytes: null },
    resource_usage_label: "",
    sleep_policy_label: "",
    sleep_status: ""
  };
  return {
    ...presented,
    resource_usage_label: resourceUsageLabel(presented.resource_usage),
    sleep_policy_label: sleepPolicyLabel(presented),
    sleep_status: sleepStatusLabel(presented)
  };
}

function presentProfileWithResourceUsage(
  profile: BrowserProfile,
  dataRoot: string,
  resourceUsage: OwnedProcessResourceUsage | undefined,
  browserRuntime: BrowserRuntime | undefined,
  redactSecrets = false
): PresentedBrowserProfile {
  const presented = presentProfile(
    profile,
    dataRoot,
    browserRuntime,
    redactSecrets
  );
  const withResourceUsage = {
    ...presented,
    resource_usage: resourceUsage ?? { owned_process_count: 0, rss_bytes: null }
  };
  return {
    ...withResourceUsage,
    resource_usage_label: resourceUsageLabel(withResourceUsage.resource_usage),
    sleep_status: sleepStatusLabel(withResourceUsage)
  };
}

export async function dashboardProfiles(
  profiles: BrowserProfile[],
  url: URL,
  config: CloakHubConfig,
  browserRuntime: BrowserRuntime | undefined
): Promise<PresentedBrowserProfile[]> {
  const sorted = sortDashboardProfiles(profiles);
  const resourceUsageByProfileId = await ownedProcessResourceUsageByProfile(
    config.dataRoot,
    sorted.map((profile) => profile.profile_id)
  );
  return sorted.map((profile) =>
    presentProfileWithResourceUsage(
      redactDashboardProfile(profile),
      config.dataRoot,
      resourceUsageByProfileId.get(profile.profile_id),
      browserRuntime,
      true
    )
  );
}

function sortDashboardProfiles(profiles: BrowserProfile[]): BrowserProfile[] {
  return [...profiles].sort((left, right) => {
    return (
      left.instance_status.localeCompare(right.instance_status) ||
      timestampMs(right.last_activity_at) -
        timestampMs(left.last_activity_at) ||
      left.profile_id.localeCompare(right.profile_id)
    );
  });
}

function redactDashboardProfile(profile: BrowserProfile): BrowserProfile {
  return {
    ...profile,
    last_launch_error: profile.last_launch_error
      ? redactProfileSecrets(
          profile.last_launch_error,
          profile.cdp_token ? [profile.cdp_token] : []
        )
      : null
  };
}

function profileDataDir(dataRoot: string, profileId: string): string {
  return join(dataRoot, "profiles", profileId);
}

function sleepPolicyLabel(
  profile: BrowserProfile | PresentedBrowserProfile
): string {
  if (profile.sleep_policy_status.mode === "never") {
    return "never-sleep";
  }

  return `Sleep Policy: ${profile.sleep_policy_status.effective_minutes} minutes`;
}

function sleepStatusLabel(profile: PresentedBrowserProfile): string {
  if (profile.sleep_policy_status.blocks_sleep) {
    return "Sleep Blocker: never-sleep policy";
  }

  if (profile.cdp_session_count > 0) {
    return "Sleep Blocker: active CDP Session";
  }

  if (profile.instance_status !== "running") {
    return "Sleep Countdown: not running";
  }

  if (
    !profile.last_activity_at ||
    profile.sleep_policy_status.effective_minutes === null
  ) {
    return "Sleep Countdown: unavailable";
  }

  const remainingMs =
    timestampMs(profile.last_activity_at) +
    profile.sleep_policy_status.effective_minutes * 60 * 1000 -
    Date.now();
  if (remainingMs <= 0) {
    return "Sleep Countdown: due now";
  }

  return `Sleep Countdown: ${formatDuration(remainingMs)}`;
}

function resourceUsageLabel(resourceUsage: OwnedProcessResourceUsage): string {
  if (resourceUsage.rss_bytes === null) {
    return "Approx. Resource Usage: unavailable";
  }

  return `Approx. Resource Usage: ${formatBytes(resourceUsage.rss_bytes)} RSS`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }

  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

function cdpSessionLabel(session: BrowserRuntimeCdpSessionObservation): string {
  return `${formatDuration(session.duration_ms)} ${session.remote_address ?? "unknown"} ${session.user_agent ?? ""}`.trim();
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}
