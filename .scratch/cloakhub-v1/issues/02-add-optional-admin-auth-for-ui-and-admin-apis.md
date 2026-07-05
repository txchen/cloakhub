# Add optional admin auth for UI and admin APIs

Status: ready-for-agent

## What to build

Add optional single-token admin authentication for the operator UI and admin APIs. When configured, browser-based operators can authenticate with a login cookie and admin API clients can use a bearer token. Health remains public and CDP access remains separate from admin auth.

## Acceptance criteria

- [ ] When no admin token is configured, UI and admin API access remain open.
- [ ] When an admin token is configured, protected UI and admin API routes reject unauthenticated requests.
- [ ] Browser login establishes a cookie that allows access to the UI without exposing the token in page URLs.
- [ ] Admin API bearer authentication works independently from UI cookie authentication.
- [ ] Health bypasses auth and never wakes or keeps alive a Browser Instance.
- [ ] Tests cover configured and unconfigured auth behavior, invalid credentials, cookie login, bearer auth, and health bypass.

## Blocked by

- [01-bootstrap-app-shell-config-data-root-health-and-test-harness.md](./01-bootstrap-app-shell-config-data-root-health-and-test-harness.md)
