# Track CDP Sessions and spin down idle headless instances

Status: ready-for-agent

## What to build

Track active CDP Sessions and use them in idle Spin-down decisions for headless Browser Instances. CDP websocket connections and client-to-browser messages count as Instance Activity, open CDP Sessions block Spin-down, passive polling does not, and idle headless Browser Instances spin down gracefully when their Sleep Policy allows it.

## Acceptance criteria

- [ ] Runtime State tracks active CDP Sessions with count, duration, remote address, and optional user agent/header metadata.
- [ ] Open CDP Sessions block Spin-down indefinitely in v1.
- [ ] CDP messages and discovery requests update last activity according to the PRD rules.
- [ ] Passive UI polling, health checks, and profile/status reads do not update Instance Activity.
- [ ] Idle timers use monotonic time for live decisions and persist wall-clock Lifecycle History.
- [ ] Idle Spin-down closes affected clients, stops Owned Processes gracefully, records stop reason, and updates status.
- [ ] Tests cover fake-clock idle rules, CDP session blockers, passive polling exclusion, stop reason persistence, and API/UI status observations.

## Blocked by

- [07-serve-stable-cdp-discovery-and-websocket-proxy-with-transparent-recovery.md](./07-serve-stable-cdp-discovery-and-websocket-proxy-with-transparent-recovery.md)
