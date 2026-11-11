// Package events is the bounded, durable lifecycle history in data/events.sqlite.
package events

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Input is one event to record.
type Input struct {
	ProfileID  *string
	Type       string
	Message    string
	Level      string
	OccurredAt string
	Details    map[string]any
}

// Entry is a stored event.
type Entry struct {
	ID         int64          `json:"id"`
	ProfileID  *string        `json:"profile_id"`
	Type       string         `json:"type"`
	Message    string         `json:"message"`
	Level      string         `json:"level"`
	OccurredAt string         `json:"occurred_at"`
	Details    map[string]any `json:"details"`
}

// Query filters a page of events, newest first.
type Query struct {
	ProfileID, Type, Since, Until string
	Before, Limit                 int64
}

// Page is a page of events and the cursor for older ones.
type Page struct {
	Events     []Entry `json:"events"`
	NextBefore *int64  `json:"next_before"`
}

// Recorder records events; nil-safe use goes through Record.
type Recorder interface {
	Record(Input)
}

// Log is the SQLite-backed event log.
type Log struct {
	mu     sync.Mutex
	db     *sql.DB
	closed bool
}

const retained = 100000

// Open opens (creating if needed) the event log.
func Open(dataRoot string) (*Log, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataRoot, "events.sqlite")+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      level TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_profile_id ON events(profile_id, id);
    CREATE INDEX IF NOT EXISTS events_occurred_at ON events(occurred_at);`); err != nil {
		db.Close()
		return nil, err
	}
	return &Log{db: db}, nil
}

// Record stores an event and prunes history beyond the retention bound.
func (l *Log) Record(event Input) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	level := event.Level
	if level == "" {
		level = "info"
	}
	occurredAt := event.OccurredAt
	if occurredAt == "" {
		occurredAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	details := event.Details
	if details == nil {
		details = map[string]any{}
	}
	detailsJSON, _ := json.Marshal(details)
	tx, err := l.db.Begin()
	if err != nil {
		return
	}
	if _, err := tx.Exec("INSERT INTO events (profile_id, type, message, level, occurred_at, details_json) VALUES (?, ?, ?, ?, ?, ?)",
		event.ProfileID, event.Type, event.Message, level, occurredAt, string(detailsJSON)); err != nil {
		tx.Rollback()
		return
	}
	if _, err := tx.Exec("DELETE FROM events WHERE id <= (SELECT MAX(id) - ? FROM events)", retained); err != nil {
		tx.Rollback()
		return
	}
	tx.Commit()
}

// List returns a page of events matching query.
func (l *Log) List(query Query) (Page, error) {
	var clauses []string
	var values []any
	add := func(clause string, value any) {
		clauses = append(clauses, clause)
		values = append(values, value)
	}
	if query.ProfileID != "" {
		add("profile_id = ?", query.ProfileID)
	}
	if query.Type != "" {
		add("type = ?", query.Type)
	}
	if query.Since != "" {
		add("occurred_at >= ?", query.Since)
	}
	if query.Until != "" {
		add("occurred_at <= ?", query.Until)
	}
	if query.Before > 0 {
		add("id < ?", query.Before)
	}
	limit := query.Limit
	if limit == 0 {
		limit = 100
	}
	limit = max(1, min(200, limit))
	where := ""
	if len(clauses) > 0 {
		where = "WHERE " + strings.Join(clauses, " AND ")
	}
	rows, err := l.db.Query("SELECT id, profile_id, type, message, level, occurred_at, details_json FROM events "+where+" ORDER BY id DESC LIMIT ?", append(values, limit+1)...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	page := Page{Events: []Entry{}}
	count := int64(0)
	for rows.Next() {
		count++
		var entry Entry
		var profileID sql.NullString
		var details string
		if err := rows.Scan(&entry.ID, &profileID, &entry.Type, &entry.Message, &entry.Level, &entry.OccurredAt, &details); err != nil {
			return Page{}, err
		}
		if count > limit {
			break
		}
		if profileID.Valid {
			id := profileID.String
			entry.ProfileID = &id
		}
		entry.Details = map[string]any{}
		_ = json.Unmarshal([]byte(details), &entry.Details)
		page.Events = append(page.Events, entry)
	}
	if count > limit && len(page.Events) > 0 {
		next := page.Events[len(page.Events)-1].ID
		page.NextBefore = &next
	}
	return page, nil
}

// Close stops recording and closes the database.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	return l.db.Close()
}
