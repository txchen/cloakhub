# Serve stable CDP discovery and websocket proxy with Transparent Recovery

Status: ready-for-agent

## What to build

Expose stable profile-level CDP endpoints that proxy through CloakHub instead of exposing internal browser ports. CDP discovery and websocket access should authenticate as required, trigger Transparent Recovery for stopped Browser Instances, serialize launch per Browser Profile, and return Chrome-compatible discovery shapes with websocket URLs rewritten through CloakHub.

## Acceptance criteria

- [ ] Stable CDP URL and discovery endpoints use Profile ID paths and work before a Browser Instance is running.
- [ ] Accessing wake-capable CDP endpoints starts a stopped Browser Instance and waits until the requested endpoint is usable.
- [ ] Concurrent wake requests for the same Browser Profile share one launch attempt and observe the same result.
- [ ] CDP discovery responses remain Chrome-compatible and rewrite websocket URLs through CloakHub.
- [ ] Internal CDP ports remain private and are never exposed directly to clients.
- [ ] Launch failures persist Lifecycle History and return a clear non-looping error.
- [ ] Tests cover auth-before-wake, launch serialization, discovery rewriting, websocket proxying, successful recovery, and failed recovery.

## Blocked by

- [06-start-stop-and-restart-headless-browser-instances.md](./06-start-stop-and-restart-headless-browser-instances.md)
