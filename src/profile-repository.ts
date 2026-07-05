import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { BrowserProfile, CreateProfileInput, UpdateProfileInput } from "./profile";

export interface ProfileRepository {
  close(): void;
  create(input: CreateProfileInput): BrowserProfile;
  delete(profileId: string): void;
  get(profileId: string): BrowserProfile | undefined;
  list(): BrowserProfile[];
  migrate(): void;
  recordDeleteError(profileId: string, error: string): void;
  update(profileId: string, input: UpdateProfileInput): BrowserProfile | undefined;
}

type ProfileRow = BrowserProfile;

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
        last_delete_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
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
          last_delete_error,
          created_at,
          updated_at
        )
        VALUES ($profile_id, $display_name, $notes, 'stopped', NULL, $created_at, $updated_at)
      `
      )
      .run({
        $created_at: now,
        $display_name: input.display_name ?? input.profile_id,
        $notes: input.notes ?? "",
        $profile_id: input.profile_id,
        $updated_at: now
      });

    return this.get(input.profile_id)!;
  }

  list(): BrowserProfile[] {
    return this.db
      .query("SELECT * FROM profiles ORDER BY profile_id")
      .all() as ProfileRow[];
  }

  get(profileId: string): BrowserProfile | undefined {
    return (
      this.db
        .query("SELECT * FROM profiles WHERE profile_id = $profile_id")
        .get({ $profile_id: profileId }) as ProfileRow | null
    ) ?? undefined;
  }

  update(profileId: string, input: UpdateProfileInput): BrowserProfile | undefined {
    if (input.profile_id !== undefined && input.profile_id !== profileId) {
      throw new Error("Profile ID is immutable");
    }

    const existing = this.get(profileId);
    if (!existing) {
      return undefined;
    }

    this.db
      .query(
        `
        UPDATE profiles
        SET display_name = $display_name,
            notes = $notes,
            updated_at = $updated_at
        WHERE profile_id = $profile_id
      `
      )
      .run({
        $display_name: input.display_name ?? existing.display_name,
        $notes: input.notes ?? existing.notes,
        $profile_id: profileId,
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

  delete(profileId: string): void {
    this.db
      .query("DELETE FROM profiles WHERE profile_id = $profile_id")
      .run({ $profile_id: profileId });
  }

  close(): void {
    this.db.close();
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
