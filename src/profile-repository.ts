import { Database } from "bun:sqlite";
import { join } from "node:path";

import {
  DEFAULT_LAUNCH_PROFILE_FIELDS,
  resolveSleepPolicy,
  type BrowserProfile,
  type CreateProfileInput,
  type LaunchProfileFields,
  type ProfileTag,
  type StopReason,
  type UpdateProfileInput
} from "./profile";

export interface ProfileRepository {
  close(): void;
  create(input: CreateProfileInput): BrowserProfile;
  delete(profileId: string): void;
  get(profileId: string): BrowserProfile | undefined;
  list(): BrowserProfile[];
  markAllStopped(reason: StopReason, occurredAt: string): void;
  markFailed(profileId: string, error: string, occurredAt: string): void;
  markLaunchFailed(profileId: string, error: string, occurredAt: string): void;
  markRunning(profileId: string, occurredAt: string): void;
  markStarting(profileId: string): void;
  markStopped(profileId: string, reason: StopReason, occurredAt: string): void;
  markStopping(profileId: string): void;
  migrate(): void;
  recordActivity(profileId: string, occurredAt: string): void;
  recordDeleteError(profileId: string, error: string): void;
  update(profileId: string, input: UpdateProfileInput): BrowserProfile | undefined;
}

type ProfileRow = Omit<BrowserProfile, keyof LaunchProfileFields> & {
  launch_profile_json?: string;
  tags_json?: string;
};

export function openProfileRepository(dataRoot: string): ProfileRepository {
  return new SqliteProfileRepository(new Database(join(dataRoot, "cloakhub.sqlite")));
}

class SqliteProfileRepository implements ProfileRepository {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        profile_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        instance_status TEXT NOT NULL DEFAULT 'stopped',
        last_activity_at TEXT,
        last_delete_error TEXT,
        last_launch_error TEXT,
        last_launch_failed_at TEXT,
        last_started_at TEXT,
        last_stop_reason TEXT,
        last_stopped_at TEXT,
        launch_profile_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    this.ensureColumn("profiles", "launch_profile_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("profiles", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("profiles", "last_activity_at", "TEXT");
    this.ensureColumn("profiles", "last_launch_error", "TEXT");
    this.ensureColumn("profiles", "last_launch_failed_at", "TEXT");
    this.ensureColumn("profiles", "last_started_at", "TEXT");
    this.ensureColumn("profiles", "last_stop_reason", "TEXT");
    this.ensureColumn("profiles", "last_stopped_at", "TEXT");
  }

  create(input: CreateProfileInput): BrowserProfile {
    const now = nowIso();
    this.db
      .query(
        `
        INSERT INTO profiles (
          profile_id,
          display_name,
          notes,
          instance_status,
          last_activity_at,
          last_delete_error,
          last_launch_error,
          last_launch_failed_at,
          last_started_at,
          last_stop_reason,
          last_stopped_at,
          launch_profile_json,
          tags_json,
          created_at,
          updated_at
        )
        VALUES (
          $profile_id,
          $display_name,
          $notes,
          'stopped',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          $launch_profile_json,
          $tags_json,
          $created_at,
          $updated_at
        )
      `
      )
      .run({
        $created_at: now,
        $display_name: input.display_name ?? input.profile_id,
        $launch_profile_json: JSON.stringify(launchProfileFields({ ...DEFAULT_LAUNCH_PROFILE_FIELDS, ...input })),
        $notes: input.notes ?? "",
        $profile_id: input.profile_id,
        $tags_json: JSON.stringify(input.tags ?? []),
        $updated_at: now
      });

    return this.get(input.profile_id)!;
  }

  list(): BrowserProfile[] {
    return (this.db
      .query("SELECT * FROM profiles ORDER BY profile_id")
      .all() as ProfileRow[]).map(rowToProfile);
  }

  get(profileId: string): BrowserProfile | undefined {
    const row =
      this.db
        .query("SELECT * FROM profiles WHERE profile_id = $profile_id")
        .get({ $profile_id: profileId }) as ProfileRow | null;

    return row ? rowToProfile(row) : undefined;
  }

  update(profileId: string, input: UpdateProfileInput): BrowserProfile | undefined {
    if (input.profile_id !== undefined && input.profile_id !== profileId) {
      throw new Error("Profile ID is immutable");
    }

    const existing = this.get(profileId);
    if (!existing) {
      return undefined;
    }

    const nextLaunchProfile = launchProfileFields({ ...existing, ...input });
    const nextTags = input.tags ?? existing.tags;

    this.db
      .query(
        `
        UPDATE profiles
        SET display_name = $display_name,
            notes = $notes,
            launch_profile_json = $launch_profile_json,
            tags_json = $tags_json,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $display_name: input.display_name ?? existing.display_name,
        $launch_profile_json: JSON.stringify(nextLaunchProfile),
        $notes: input.notes ?? existing.notes,
        $profile_id: profileId,
        $tags_json: JSON.stringify(nextTags),
        $updated_at: nowIso()
      });

    return this.get(profileId);
  }

  recordDeleteError(profileId: string, error: string): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET last_delete_error = $last_delete_error,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $last_delete_error: error,
        $profile_id: profileId,
        $updated_at: nowIso()
      });
  }

  markStarting(profileId: string): void {
    this.setInstanceStatus(profileId, "starting");
  }

  markRunning(profileId: string, occurredAt: string): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET instance_status = 'running',
            last_started_at = $last_started_at,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $last_started_at: occurredAt,
        $profile_id: profileId,
        $updated_at: nowIso()
      });
  }

  markStopping(profileId: string): void {
    this.setInstanceStatus(profileId, "stopping");
  }

  markStopped(profileId: string, reason: StopReason, occurredAt: string): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET instance_status = 'stopped',
            last_stopped_at = $last_stopped_at,
            last_stop_reason = $last_stop_reason,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $last_stop_reason: reason,
        $last_stopped_at: occurredAt,
        $profile_id: profileId,
        $updated_at: nowIso()
      });
  }

  markAllStopped(reason: StopReason, occurredAt: string): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET instance_status = 'stopped',
            last_stopped_at = $last_stopped_at,
            last_stop_reason = $last_stop_reason,
            updated_at = $updated_at
        WHERE instance_status <> 'stopped'
      `
      )
      .run({
        $last_stop_reason: reason,
        $last_stopped_at: occurredAt,
        $updated_at: nowIso()
      });
  }

  markFailed(profileId: string, error: string, occurredAt: string): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET instance_status = 'failed',
            last_launch_error = $last_launch_error,
            last_launch_failed_at = $last_launch_failed_at,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $last_launch_error: error,
        $last_launch_failed_at: occurredAt,
        $profile_id: profileId,
        $updated_at: nowIso()
      });
  }

  markLaunchFailed(profileId: string, error: string, occurredAt: string): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET instance_status = 'failed',
            last_launch_error = $last_launch_error,
            last_launch_failed_at = $last_launch_failed_at,
            last_stop_reason = 'launch failure',
            last_stopped_at = $last_stopped_at,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $last_launch_error: error,
        $last_launch_failed_at: occurredAt,
        $last_stopped_at: occurredAt,
        $profile_id: profileId,
        $updated_at: nowIso()
      });
  }

  recordActivity(profileId: string, occurredAt: string): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET last_activity_at = $last_activity_at,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $last_activity_at: occurredAt,
        $profile_id: profileId,
        $updated_at: nowIso()
      });
  }

  delete(profileId: string): void {
    this.db
      .query("DELETE FROM profiles WHERE profile_id = $profile_id")
      .run({ $profile_id: profileId });
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  private setInstanceStatus(profileId: string, status: BrowserProfile["instance_status"]): void {
    this.db
      .query(
        `
        UPDATE profiles
        SET instance_status = $instance_status,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $instance_status: status,
        $profile_id: profileId,
        $updated_at: nowIso()
      });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToProfile(row: ProfileRow): BrowserProfile {
  const launchProfile = parseJson<LaunchProfileFields>(
    row.launch_profile_json,
    DEFAULT_LAUNCH_PROFILE_FIELDS
  );
  const tags = parseJson<ProfileTag[]>(row.tags_json, []);

  const { launch_profile_json: _launchProfileJson, tags_json: _tagsJson, ...profileRow } = row;
  const sleepPolicy = launchProfile.sleep_policy ?? DEFAULT_LAUNCH_PROFILE_FIELDS.sleep_policy;

  return {
    ...profileRow,
    ...DEFAULT_LAUNCH_PROFILE_FIELDS,
    ...launchProfile,
    sleep_policy: sleepPolicy,
    sleep_policy_status: resolveSleepPolicy(sleepPolicy),
    tags
  };
}

function launchProfileFields(input: LaunchProfileFields): Omit<LaunchProfileFields, "tags"> {
  return {
    clipboard_sync: input.clipboard_sync,
    color_scheme: input.color_scheme,
    custom_launch_args: input.custom_launch_args,
    fingerprint_seed: input.fingerprint_seed,
    geoip: input.geoip,
    gpu_renderer: input.gpu_renderer,
    gpu_vendor: input.gpu_vendor,
    hardware_concurrency: input.hardware_concurrency,
    headless: input.headless,
    human_preset: input.human_preset,
    humanize: input.humanize,
    locale: input.locale,
    platform: input.platform,
    proxy: input.proxy,
    screen_height: input.screen_height,
    screen_width: input.screen_width,
    sleep_policy: input.sleep_policy,
    timezone: input.timezone,
    user_agent: input.user_agent
  };
}

function parseJson<Value>(value: string | undefined, fallback: Value): Value {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as Value;
  } catch {
    return fallback;
  }
}
