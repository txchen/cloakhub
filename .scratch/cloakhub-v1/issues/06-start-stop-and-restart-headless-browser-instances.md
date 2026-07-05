# Start, stop, and restart headless Browser Instances

Status: ready-for-agent

## What to build

Implement the first Browser Instance lifecycle path for headless profiles: explicit start, stop, and restart. CloakHub discovers only a CloakBrowser Binary, launches it with a private CDP endpoint and persistent user-data directory, tracks Runtime State in memory, persists Lifecycle History, and tears down only Owned Processes.

## Acceptance criteria

- [ ] Explicit start launches a headless Browser Instance for a registered Browser Profile using the persistent user-data directory.
- [ ] CloakBrowser Binary discovery follows the configured v1 order and never falls back to stock Chrome or Chromium.
- [ ] Explicit stop gracefully closes the browser, waits a short grace period, and hard-kills remaining Owned Processes if needed.
- [ ] Restart performs stop then start and records appropriate Lifecycle History.
- [ ] Instance Status transitions through stopped, starting, running, stopping, and failed as appropriate.
- [ ] Startup cleanup targets only Owned Processes and marks instances stopped without broad process-name cleanup.
- [ ] Tests use fake processes where possible to cover lifecycle transitions, launch failures, cleanup, stop reasons, and explicit stop overriding active clients.

## Blocked by

- [04-preserve-cloakbrowser-manager-launch-profile-fields.md](./04-preserve-cloakbrowser-manager-launch-profile-fields.md)
- [05-add-sleep-policy-editing-and-stopped-status-visibility.md](./05-add-sleep-policy-editing-and-stopped-status-visibility.md)
