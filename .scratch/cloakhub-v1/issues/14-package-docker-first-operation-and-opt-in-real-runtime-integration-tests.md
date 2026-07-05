# Package Docker-first operation and opt-in real-runtime integration tests

Status: ready-for-agent

## What to build

Package CloakHub for Docker-first operation and add opt-in integration tests that exercise real CloakBrowser and KasmVNC paths when the environment supports them. Docker should expose the intended port, use `/data` as the Data Root, bind safely by default through compose, and avoid runtime binary downloads.

## Acceptance criteria

- [ ] Docker operation exposes port 7788 and sets `CLOAKHUB_DATA_DIR=/data`.
- [ ] Compose defaults map `127.0.0.1:7788:7788` while the container can bind `0.0.0.0` internally.
- [ ] Non-Docker Linux operation remains possible when the operator provides CloakBrowser and KasmVNC dependencies.
- [ ] Missing CloakBrowser Binary is a startup failure and CloakHub does not download it at runtime.
- [ ] Opt-in integration tests cover real headless launch, headed launch with KasmVNC/noVNC path, CDP Transparent Recovery, Spin-down then recovery preserving Browser Persistence, and explicit Stop overriding active clients.
- [ ] Normal CI can run without launching real CloakBrowser/KasmVNC unless the controlled integration environment is enabled.
- [ ] Documentation explains environment variables, Docker defaults, dependency expectations, and integration test opt-in.

## Blocked by

- [10-launch-headed-browser-instances-and-open-manual-novnc-viewer.md](./10-launch-headed-browser-instances-and-open-manual-novnc-viewer.md)
- [12-enforce-running-instance-limit-and-capacity-preemption.md](./12-enforce-running-instance-limit-and-capacity-preemption.md)
