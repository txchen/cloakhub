import { Database } from "bun:sqlite";
import { join } from "node:path";

export interface EventInput {
  profile_id: string | null;
  type: string;
  message: string;
  level?: "info" | "warning" | "error";
  occurred_at?: string;
  details?: Record<string, string | number | boolean | null>;
}
export interface EventEntry extends Required<EventInput> {
  id: number;
}
export interface EventQuery {
  profile_id?: string;
  type?: string;
  since?: string;
  until?: string;
  before?: number;
  limit?: number;
}
export interface EventPage {
  events: EventEntry[];
  next_before: number | null;
}
export interface EventLog {
  record(event: EventInput): void;
  list(query?: EventQuery): EventPage;
  close(): void;
}

/** Bounded, durable lifecycle history, independent of profile deletion. */
export function openEventLog(dataRoot: string): EventLog {
  const db = new Database(join(dataRoot, "events.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
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
    CREATE INDEX IF NOT EXISTS events_occurred_at ON events(occurred_at);
  `);
  const insert = db.query(
    `INSERT INTO events (profile_id, type, message, level, occurred_at, details_json) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const prune = db.query(
    "DELETE FROM events WHERE id <= (SELECT MAX(id) - 100000 FROM events)"
  );
  const record = db.transaction((event: EventInput) => {
    insert.run(
      event.profile_id,
      event.type,
      event.message,
      event.level ?? "info",
      event.occurred_at ?? new Date().toISOString(),
      JSON.stringify(event.details ?? {})
    );
    prune.run();
  });
  let closed = false;
  return {
    record(event) {
      if (!closed) record(event);
    },
    list(query = {}) {
      const clauses: string[] = [];
      const values: Array<string | number> = [];
      for (const [column, operator, value] of [
        ["profile_id", "=", query.profile_id],
        ["type", "=", query.type],
        ["occurred_at", ">=", query.since],
        ["occurred_at", "<=", query.until],
        ["id", "<", query.before]
      ] as const) {
        if (value !== undefined) {
          clauses.push(`${column} ${operator} ?`);
          values.push(value);
        }
      }
      const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 100)));
      const rows = db
        .query(
          `SELECT * FROM events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`
        )
        .all(...values, limit + 1) as Array<
        Omit<EventEntry, "details"> & { details_json: string }
      >;
      const events = rows
        .slice(0, limit)
        .map(({ details_json, ...event }) => ({
          ...event,
          details: JSON.parse(details_json) as EventEntry["details"]
        }));
      return {
        events,
        next_before: rows.length > limit ? events.at(-1)!.id : null
      };
    },
    close: () => {
      closed = true;
      db.close();
    }
  };
}
