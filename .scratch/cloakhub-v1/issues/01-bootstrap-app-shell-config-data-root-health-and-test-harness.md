# Bootstrap CloakHub app shell, config, Data Root, health, and test harness

Status: ready-for-agent

## What to build

Create the first runnable CloakHub application shell: a Bun backend that loads configuration, validates the Data Root, serves the operational UI shell, exposes minimal health, and has a test harness ready for later slices. This slice should make the repo executable and give every later Browser Profile and Browser Instance feature a consistent foundation.

## Acceptance criteria

- [ ] CloakHub starts with Bun using documented defaults for host, port, Data Root, and Running Instance Limit.
- [ ] Startup creates or validates the Data Root and fails clearly when the Data Root is unusable.
- [ ] `GET /api/health` returns minimal non-sensitive health and does not require auth.
- [ ] The UI root renders a lightweight operational shell served by the Bun backend.
- [ ] Automated tests cover configuration defaults, environment overrides, Data Root validation, and health behavior.

## Blocked by

None - can start immediately
