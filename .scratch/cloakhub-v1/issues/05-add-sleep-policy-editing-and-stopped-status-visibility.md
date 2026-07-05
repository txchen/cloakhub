# Add Sleep Policy editing and stopped-status visibility

Status: ready-for-agent

## What to build

Add Sleep Policy support to Browser Profiles and make stopped Browser Instance status visible in the API and UI. Operators can use the global default, set a per-profile timeout override, or mark a profile as never-sleep. Never-sleep profiles must be visually obvious because they trade resource efficiency for availability.

## Acceptance criteria

- [ ] Browser Profiles can resolve Sleep Policy from global default, per-profile timeout, or never-sleep.
- [ ] The default idle timeout is 30 minutes when no override is configured.
- [ ] Sleep Policy changes persist in SQLite and appear in profile API responses.
- [ ] The UI clearly shows stopped Instance Status and never-sleep profiles.
- [ ] Profile list/status polling does not count as Instance Activity.
- [ ] Tests cover Sleep Policy resolution, validation ranges, persistence, and stopped status responses.

## Blocked by

- [03-register-list-read-edit-and-delete-stopped-browser-profiles.md](./03-register-list-read-edit-and-delete-stopped-browser-profiles.md)
