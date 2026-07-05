# Enforce Running Instance Limit and Capacity Preemption

Status: ready-for-agent

## What to build

Enforce the configured Running Instance Limit across headed and headless Browser Instances. When capacity is full, Transparent Recovery or explicit start may preempt the least-recently-active eligible instance, but must protect active CDP Sessions and recent Manual Input. If no instance is eligible, recovery/start returns a retryable capacity error.

## Acceptance criteria

- [ ] The default Running Instance Limit is 10 and startup validates it against fixed internal resource ranges.
- [ ] The limit applies to both headed and headless Browser Instances.
- [ ] Capacity Preemption never selects an instance with active CDP Sessions.
- [ ] Capacity Preemption never selects an instance with Manual Input in the last 60 seconds.
- [ ] Viewer-only instances and never-sleep profiles without protected activity may be preempted.
- [ ] The least-recently-active eligible instance is selected and stopped with stop reason `capacity preemption`.
- [ ] If no eligible instance exists, start/recovery fails with a clear retryable capacity error.
- [ ] Tests cover limit validation, eligibility rules, least-recently-active selection, never-sleep behavior, viewer-only preemption, protected-client rejection, and persisted stop reason.

## Blocked by

- [08-track-cdp-sessions-and-spin-down-idle-headless-instances.md](./08-track-cdp-sessions-and-spin-down-idle-headless-instances.md)
- [11-implement-tested-rfb-compatibility-proxy-manual-input-and-clipboard-path.md](./11-implement-tested-rfb-compatibility-proxy-manual-input-and-clipboard-path.md)
