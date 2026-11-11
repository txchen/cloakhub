// Shapes of the JSON the Go server sends to the UI (internal/web/presentation.go,
// internal/profile and internal/events).

export type SleepPolicy =
  | { mode: "default" }
  | { mode: "minutes"; minutes: number }
  | { mode: "never" };

export interface LaunchProfileFields {
  clipboard_sync: boolean;
  color_scheme: "light" | "dark" | "system";
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

export interface CdpSessionObservation {
  duration_ms: number;
  remote_address: string | null;
  started_at: string;
  user_agent: string | null;
}

export interface PresentedBrowserProfile extends LaunchProfileFields {
  profile_id: string;
  display_name: string;
  notes: string;
  tags?: string[];
  instance_status: "failed" | "running" | "starting" | "stopped" | "stopping";
  last_activity_at: string | null;
  last_delete_error: string | null;
  last_launch_error: string | null;
  last_launch_failed_at: string | null;
  last_manual_input_at: string | null;
  last_started_at: string | null;
  last_stop_reason: string | null;
  last_stopped_at: string | null;
  created_at: string;
  updated_at: string;
  sleep_policy_status: {
    blocks_sleep: boolean;
    effective_minutes: number | null;
    mode: SleepPolicy["mode"];
  };
  cdp_token_configured: boolean;
  cdp_session_count: number;
  cdp_session_labels: string[];
  cdp_sessions: CdpSessionObservation[];
  manual_viewer_count: number;
  profile_data_dir: string;
  resource_usage: { owned_process_count: number; rss_bytes: number | null };
  resource_usage_label: string;
  sleep_policy_label: string;
  sleep_status: string;
}

export interface EventEntry {
  id: number;
  profile_id: string | null;
  type: string;
  message: string;
  level: "info" | "warning" | "error";
  occurred_at: string;
  details: Record<string, string | number | boolean | null>;
}

export interface EventPage {
  events: EventEntry[];
  next_before: number | null;
}
