# Preserve CloakBrowser Manager launch/profile fields

Status: ready-for-agent

## What to build

Expand Browser Profiles so operators can configure the launch and identity fields CloakHub must preserve from CloakBrowser Manager: fingerprint, proxy, locale/timezone/geoip, platform, screen, GPU, hardware concurrency, user agent, color scheme, humanize settings, headless mode, clipboard preference, custom launch args, tags, and notes. Server validation is authoritative, with UI validation for ergonomics.

## Acceptance criteria

- [ ] Profile create/edit supports the v1 launch/profile field set needed for CloakBrowser Manager compatibility.
- [ ] Server validation rejects invalid proxy syntax, screen dimensions, idle-affecting values, and CloakHub-owned launch flags.
- [ ] Proxy credentials are masked in UI responses by default and are redacted from logs/errors.
- [ ] Tags, optional tag colors, and notes are visible and editable in the UI.
- [ ] Launch-affecting edits made while no Browser Instance is running are persisted for the next start.
- [ ] Tests cover validation, persistence, redaction, launch-arg protection, and round-tripping the supported field set.

## Blocked by

- [03-register-list-read-edit-and-delete-stopped-browser-profiles.md](./03-register-list-read-edit-and-delete-stopped-browser-profiles.md)
