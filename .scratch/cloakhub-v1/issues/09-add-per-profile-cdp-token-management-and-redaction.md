# Add per-profile CDP Token management and redaction

Status: ready-for-agent

## What to build

Add optional per-profile CDP Tokens for that Browser Profile's CDP endpoints. Tokens are disabled by default, stored in plaintext by explicit decision, managed through admin-only create/regenerate/revoke/view actions, accepted as bearer tokens or query tokens, and redacted from logs/errors.

## Acceptance criteria

- [ ] A Browser Profile can have at most one active CDP Token in v1, disabled by default.
- [ ] Admin-authenticated operators can create, view, regenerate, and revoke the CDP Token.
- [ ] CDP endpoints require the per-profile CDP Token only when the profile has one configured.
- [ ] Admin auth does not grant CDP access, and CDP Tokens do not grant UI/admin API access.
- [ ] UI warns when CDP access is open because no CDP Token exists.
- [ ] Copying token-bearing CDP URLs is explicit and displays a leakage warning.
- [ ] CDP Tokens are redacted from logs/errors while stored plainly in SQLite.
- [ ] Tests cover token scoping, bearer and query auth, disabled-token behavior, regenerate/revoke actions, and redaction.

## Blocked by

- [07-serve-stable-cdp-discovery-and-websocket-proxy-with-transparent-recovery.md](./07-serve-stable-cdp-discovery-and-websocket-proxy-with-transparent-recovery.md)
