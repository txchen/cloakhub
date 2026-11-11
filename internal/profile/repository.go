package profile

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// Repository persists Browser Profiles in data/cloakhub.sqlite. The schema is
// shared with earlier releases, so existing data directories keep working.
type Repository struct {
	db *sql.DB
}

// NowISO is the timestamp format stored and returned by CloakHub.
func NowISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// OpenRepository opens (creating if needed) the profile database.
func OpenRepository(dataRoot string) (*Repository, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataRoot, "cloakhub.sqlite")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	// One connection serializes writes the way the single-threaded runtime did.
	db.SetMaxOpenConns(1)
	return &Repository{db: db}, nil
}

// Migrate creates tables and adds columns introduced by later releases.
func (r *Repository) Migrate() error {
	if _, err := r.db.Exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        profile_id TEXT PRIMARY KEY,
        cdp_token TEXT,
        display_name TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        instance_status TEXT NOT NULL DEFAULT 'stopped',
        last_activity_at TEXT,
        last_delete_error TEXT,
        last_launch_error TEXT,
        last_launch_failed_at TEXT,
        last_manual_input_at TEXT,
        last_started_at TEXT,
        last_stop_reason TEXT,
        last_stopped_at TEXT,
        launch_profile_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `); err != nil {
		return err
	}
	columns := [][2]string{
		{"tags_json", "TEXT NOT NULL DEFAULT '[]'"},
		{"cdp_token", "TEXT"},
		{"launch_profile_json", "TEXT NOT NULL DEFAULT '{}'"},
		{"last_activity_at", "TEXT"},
		{"last_launch_error", "TEXT"},
		{"last_launch_failed_at", "TEXT"},
		{"last_manual_input_at", "TEXT"},
		{"last_started_at", "TEXT"},
		{"last_stop_reason", "TEXT"},
		{"last_stopped_at", "TEXT"},
	}
	for _, column := range columns {
		if err := r.ensureColumn("profiles", column[0], column[1]); err != nil {
			return err
		}
	}
	return nil
}

func (r *Repository) ensureColumn(table, column, definition string) error {
	rows, err := r.db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var (
			cid        int
			name, kind string
			notNull    int
			value      sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &kind, &notNull, &value, &pk); err != nil {
			rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	rows.Close()
	if found {
		return nil
	}
	_, err = r.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, definition))
	return err
}

// Close releases the database.
func (r *Repository) Close() error { return r.db.Close() }

// Create stores a new profile.
func (r *Repository) Create(input CreateInput) (*Profile, error) {
	now := NowISO(time.Now())
	launch, _ := json.Marshal(input.Launch)
	tags, _ := json.Marshal(nonNilTags(input.Tags))
	displayName := input.DisplayName
	if displayName == "" {
		displayName = input.ProfileID
	}
	_, err := r.db.Exec(`
        INSERT INTO profiles (profile_id, cdp_token, display_name, tags_json, notes, instance_status,
          last_activity_at, last_delete_error, last_launch_error, last_launch_failed_at,
          last_manual_input_at, last_started_at, last_stop_reason, last_stopped_at,
          launch_profile_json, created_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, 'stopped', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
		input.ProfileID, displayName, string(tags), input.Notes, string(launch), now, now)
	if err != nil {
		return nil, err
	}
	return r.Get(input.ProfileID), nil
}

const profileColumns = `profile_id, cdp_token, display_name, notes, instance_status, last_activity_at,
  last_delete_error, last_launch_error, last_launch_failed_at, last_manual_input_at, last_started_at,
  last_stop_reason, last_stopped_at, launch_profile_json, tags_json, created_at, updated_at`

type scanner interface{ Scan(dest ...any) error }

func scanProfile(row scanner) (*Profile, error) {
	var (
		p                     Profile
		token                 sql.NullString
		lastActivity          sql.NullString
		lastDeleteError       sql.NullString
		lastLaunchError       sql.NullString
		lastLaunchFailedAt    sql.NullString
		lastManualInput       sql.NullString
		lastStarted           sql.NullString
		lastStopReason        sql.NullString
		lastStopped           sql.NullString
		launchJSON, tagsJSON  sql.NullString
		notes, instanceStatus sql.NullString
	)
	if err := row.Scan(&p.ProfileID, &token, &p.DisplayName, &notes, &instanceStatus, &lastActivity,
		&lastDeleteError, &lastLaunchError, &lastLaunchFailedAt, &lastManualInput, &lastStarted,
		&lastStopReason, &lastStopped, &launchJSON, &tagsJSON, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	p.CdpToken = nullable(token)
	p.Notes = notes.String
	p.InstanceStatus = instanceStatus.String
	p.LastActivityAt = nullable(lastActivity)
	p.LastDeleteError = nullable(lastDeleteError)
	p.LastLaunchError = nullable(lastLaunchError)
	p.LastLaunchFailedAt = nullable(lastLaunchFailedAt)
	p.LastManualInputAt = nullable(lastManualInput)
	p.LastStartedAt = nullable(lastStarted)
	p.LastStopReason = nullable(lastStopReason)
	p.LastStoppedAt = nullable(lastStopped)
	p.LaunchFields = LegacyLaunchFields()
	if launchJSON.String != "" {
		var parsed LaunchFields = LegacyLaunchFields()
		if json.Unmarshal([]byte(launchJSON.String), &parsed) == nil {
			p.LaunchFields = parsed
		}
	}
	if p.CustomLaunchArgs == nil {
		p.CustomLaunchArgs = []string{}
	}
	if p.SleepPolicy.Mode == "" {
		p.SleepPolicy = SleepPolicy{Mode: "default"}
	}
	p.Tags = []string{}
	if tagsJSON.String != "" {
		var tags []string
		if json.Unmarshal([]byte(tagsJSON.String), &tags) == nil && tags != nil {
			p.Tags = tags
		}
	}
	p.SleepPolicyStatus = ResolveSleepPolicy(p.SleepPolicy)
	return &p, nil
}

func nullable(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	s := value.String
	return &s
}

func nonNilTags(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}

// List returns every profile ordered by ID.
func (r *Repository) List() []*Profile {
	rows, err := r.db.Query("SELECT " + profileColumns + " FROM profiles ORDER BY profile_id")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var profiles []*Profile
	for rows.Next() {
		if p, err := scanProfile(rows); err == nil {
			profiles = append(profiles, p)
		}
	}
	return profiles
}

// Get returns one profile or nil.
func (r *Repository) Get(profileID string) *Profile {
	p, err := scanProfile(r.db.QueryRow("SELECT "+profileColumns+" FROM profiles WHERE profile_id = ?", profileID))
	if err != nil {
		return nil
	}
	return p
}

// Update applies an edit; it returns nil when the profile does not exist.
func (r *Repository) Update(profileID string, input UpdateInput) (*Profile, error) {
	existing := r.Get(profileID)
	if existing == nil {
		return nil, nil
	}
	launch := cloneLaunch(existing.LaunchFields)
	if input.Apply != nil {
		input.Apply(&launch)
	}
	launchJSON, _ := json.Marshal(launch)
	displayName := existing.DisplayName
	if input.DisplayName != nil {
		displayName = *input.DisplayName
	}
	notes := existing.Notes
	if input.Notes != nil {
		notes = *input.Notes
	}
	tags := existing.Tags
	if input.TagsSet {
		tags = input.Tags
	}
	tagsJSON, _ := json.Marshal(nonNilTags(tags))
	if _, err := r.db.Exec(`UPDATE profiles SET display_name = ?, tags_json = ?, notes = ?,
        launch_profile_json = ?, updated_at = ? WHERE profile_id = ?`,
		displayName, string(tagsJSON), notes, string(launchJSON), NowISO(time.Now()), profileID); err != nil {
		return nil, err
	}
	return r.Get(profileID), nil
}

func (r *Repository) exec(query string, args ...any) {
	_, _ = r.db.Exec(query, args...)
}

// SetCdpToken stores or clears (nil) a profile's CDP Token.
func (r *Repository) SetCdpToken(profileID string, token *string) *Profile {
	r.exec("UPDATE profiles SET cdp_token = ?, updated_at = ? WHERE profile_id = ?", token, NowISO(time.Now()), profileID)
	return r.Get(profileID)
}

// RecordDeleteError keeps the reason a profile's data could not be removed.
func (r *Repository) RecordDeleteError(profileID, message string) {
	r.exec("UPDATE profiles SET last_delete_error = ?, updated_at = ? WHERE profile_id = ?", message, NowISO(time.Now()), profileID)
}

func (r *Repository) setStatus(profileID, status string) {
	r.exec("UPDATE profiles SET instance_status = ?, updated_at = ? WHERE profile_id = ?", status, NowISO(time.Now()), profileID)
}

// MarkStarting records a launch in progress.
func (r *Repository) MarkStarting(profileID string) { r.setStatus(profileID, StatusStarting) }

// MarkStopping records a teardown in progress.
func (r *Repository) MarkStopping(profileID string) { r.setStatus(profileID, StatusStopping) }

// MarkRunning records a successful launch.
func (r *Repository) MarkRunning(profileID, occurredAt string) {
	r.exec("UPDATE profiles SET instance_status = 'running', last_started_at = ?, updated_at = ? WHERE profile_id = ?",
		occurredAt, NowISO(time.Now()), profileID)
}

// MarkStopped records a completed stop.
func (r *Repository) MarkStopped(profileID, reason, occurredAt string) {
	r.exec("UPDATE profiles SET instance_status = 'stopped', last_stopped_at = ?, last_stop_reason = ?, updated_at = ? WHERE profile_id = ?",
		occurredAt, reason, NowISO(time.Now()), profileID)
}

// MarkAllStopped marks every non-stopped profile stopped (startup and shutdown).
func (r *Repository) MarkAllStopped(reason, occurredAt string) {
	r.exec("UPDATE profiles SET instance_status = 'stopped', last_stopped_at = ?, last_stop_reason = ?, updated_at = ? WHERE instance_status <> 'stopped'",
		occurredAt, reason, NowISO(time.Now()))
}

// MarkFailed records a failure after launch.
func (r *Repository) MarkFailed(profileID, message, occurredAt string) {
	r.exec("UPDATE profiles SET instance_status = 'failed', last_launch_error = ?, last_launch_failed_at = ?, updated_at = ? WHERE profile_id = ?",
		message, occurredAt, NowISO(time.Now()), profileID)
}

// MarkLaunchFailed records a failed launch.
func (r *Repository) MarkLaunchFailed(profileID, message, occurredAt string) {
	r.exec(`UPDATE profiles SET instance_status = 'failed', last_launch_error = ?, last_launch_failed_at = ?,
        last_stop_reason = 'launch failure', last_stopped_at = ?, updated_at = ? WHERE profile_id = ?`,
		message, occurredAt, occurredAt, NowISO(time.Now()), profileID)
}

// RecordActivity records Instance Activity.
func (r *Repository) RecordActivity(profileID, occurredAt string) {
	r.exec("UPDATE profiles SET last_activity_at = ?, updated_at = ? WHERE profile_id = ?", occurredAt, NowISO(time.Now()), profileID)
}

// RecordManualInput records Manual Input (also Instance Activity).
func (r *Repository) RecordManualInput(profileID, occurredAt string) {
	r.exec("UPDATE profiles SET last_activity_at = ?, last_manual_input_at = ?, updated_at = ? WHERE profile_id = ?",
		occurredAt, occurredAt, NowISO(time.Now()), profileID)
}

// Delete removes a profile record.
func (r *Repository) Delete(profileID string) {
	r.exec("DELETE FROM profiles WHERE profile_id = ?", profileID)
}
