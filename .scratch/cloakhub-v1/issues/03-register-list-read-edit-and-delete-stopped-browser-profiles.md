# Register, list, read, edit, and delete stopped Browser Profiles

Status: ready-for-agent

## What to build

Let operators manage durable Browser Profiles while their Browser Instances are stopped. A Browser Profile has a user-chosen immutable Profile ID, metadata persisted in SQLite, and a profile user-data directory created under the Data Root. Deleting a stopped profile removes its user-data directory before metadata disappears, and failures leave metadata visible.

## Acceptance criteria

- [ ] Operators can create, list, read, update, and delete Browser Profiles through admin APIs and the UI.
- [ ] Profile IDs are user-chosen, unique, immutable, URL-safe, and validated with the v1 pattern.
- [ ] Creating a Browser Profile creates its persistent user-data directory under the Data Root.
- [ ] SQLite persists profile metadata and migrations run idempotently.
- [ ] Deleting a stopped Browser Profile removes browser user-data before deleting metadata.
- [ ] If filesystem cleanup fails, the Browser Profile remains visible with a clear error.
- [ ] Tests cover profile validation, persistence, migration behavior, user-data directory creation, immutable Profile IDs, and stopped-profile deletion failure modes.

## Blocked by

- [01-bootstrap-app-shell-config-data-root-health-and-test-harness.md](./01-bootstrap-app-shell-config-data-root-health-and-test-harness.md)
- [02-add-optional-admin-auth-for-ui-and-admin-apis.md](./02-add-optional-admin-auth-for-ui-and-admin-apis.md)
