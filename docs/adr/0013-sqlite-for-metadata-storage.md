# SQLite for metadata storage

CloakHub will store profile metadata, sleep policies, settings, and lifecycle timestamps in SQLite under `CLOAKHUB_DATA_DIR`, while browser state remains in per-profile user-data directories. JSON files would be simpler initially, but SQLite gives safer concurrent updates, partial writes, indexes, and migrations for Browser Persistence metadata.
