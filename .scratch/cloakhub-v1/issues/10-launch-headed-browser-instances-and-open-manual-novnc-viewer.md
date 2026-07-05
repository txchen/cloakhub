# Launch headed Browser Instances and open manual noVNC viewer

Status: ready-for-agent

## What to build

Add headed Browser Instance launch and manual viewing. Headed profiles start a per-instance KasmVNC display runtime and browser, the UI can open a noVNC-style viewer that triggers Transparent Recovery, and headless profiles show viewer unavailable without silently changing profile settings.

## Acceptance criteria

- [ ] Headed Browser Instances launch with one display/VNC runtime per instance and a private internal VNC endpoint.
- [ ] Missing KasmVNC is a startup warning, while headed launch/view fails clearly until fixed.
- [ ] Opening the manual viewer authenticates with admin auth before waking the Browser Instance.
- [ ] Viewer open triggers Transparent Recovery and waits until the manual endpoint is usable.
- [ ] Headless profiles show viewer unavailable and point operators to edit/start options without overriding headless mode.
- [ ] Viewer Presence is tracked separately from Instance Activity.
- [ ] Tests cover headed launch setup, missing KasmVNC behavior, viewer recovery, headless viewer unavailable behavior, and status responses.

## Blocked by

- [06-start-stop-and-restart-headless-browser-instances.md](./06-start-stop-and-restart-headless-browser-instances.md)
