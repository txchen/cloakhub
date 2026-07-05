# Complete operational dashboard status and resource visibility

Status: ready-for-agent

## What to build

Complete the operational dashboard so operators can understand Browser Profiles, Browser Instances, resource usage, activity, and lifecycle outcomes at a glance. The UI should support the required profile search/sort/grouping, lifecycle actions, runtime observations, warnings, and immediate refresh after actions while using `stopped` and `Spin-down` language consistently.

## Acceptance criteria

- [ ] Profile list supports search by name/tag plus sorting or grouping by Instance Status and last activity.
- [ ] Profile status panels show Instance Status, active CDP Sessions, viewer count, last Manual Input, sleep countdown or blocker, approximate Resource Usage, last stop reason, and last launch error.
- [ ] Start, Stop, Restart, Open Viewer, CDP URL copy, and CDP Token management actions refresh visible status immediately after completion.
- [ ] Explicit Stop warns or confirms when active CDP Sessions or viewers exist.
- [ ] UI copy uses `stopped` for status and distinguishes automatic Spin-down from explicit Stop.
- [ ] Proxy credentials and CDP Tokens remain masked/redacted by default in UI-visible surfaces.
- [ ] Resource Usage is attributed through Owned Processes or process groups and is approximate rather than presented as billing-grade.
- [ ] Tests or browser-level checks cover dashboard rendering, polling exclusions, action refresh, warnings, redaction, and status field accuracy.

## Blocked by

- [08-track-cdp-sessions-and-spin-down-idle-headless-instances.md](./08-track-cdp-sessions-and-spin-down-idle-headless-instances.md)
- [09-add-per-profile-cdp-token-management-and-redaction.md](./09-add-per-profile-cdp-token-management-and-redaction.md)
- [11-implement-tested-rfb-compatibility-proxy-manual-input-and-clipboard-path.md](./11-implement-tested-rfb-compatibility-proxy-manual-input-and-clipboard-path.md)
- [12-enforce-running-instance-limit-and-capacity-preemption.md](./12-enforce-running-instance-limit-and-capacity-preemption.md)
