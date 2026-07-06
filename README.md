# CloakHub

CloakHub is a Linux-focused, Docker-first manager for persistent CloakBrowser profiles and
on-demand browser runtimes. It keeps the useful parts of CloakBrowser Manager - profile
configuration, a live browser viewer, and CDP automation - but is designed for long-running
servers where idle browser processes should not stay alive forever.

CloakBrowser Manager provides an all-in-one UI for creating, launching, viewing, and automating
isolated CloakBrowser profiles. CloakHub is aimed at operators who need the same persistent
browser identities, but also want predictable resource control: instances can spin down when
they are idle, wake automatically when CDP or manual viewing resumes, and respect a configured
running-instance limit.

## Why CloakHub

- **Persistent profiles, disposable runtimes**: profile metadata and browser user-data survive,
  while browser, display, VNC, clipboard, and CDP support processes can be stopped and recreated.
- **Transparent Recovery**: stable profile-level CDP and viewer URLs can start a stopped Browser
  Instance on demand, so clients do not need a separate "launch first" step.
- **Resource-aware lifecycle**: idle Browser Instances spin down after their Sleep Policy window,
  and capacity pressure can preempt viewer-only or inactive instances.
- **Automation visibility**: open CDP sessions, manual viewer counts, last activity, stop reasons,
  and approximate owned-process resource usage are surfaced through the UI/API.
- **Bun-first runtime**: the backend directly supervises CloakBrowser, KasmVNC, ports, process
  groups, and cleanup without a Python backend service.
- **Docker-first packaging**: the published image includes the CloakBrowser Binary and KasmVNC, so
  normal deployments do not download the browser at runtime.

## CloakHub vs CloakBrowser Manager

| Area | CloakBrowser Manager | CloakHub |
| --- | --- | --- |
| Primary goal | All-in-one profile manager with launch, viewer, and CDP access. | Server-oriented profile manager with resource-efficient Browser Instance lifecycle. |
| Runtime model | Profiles are launched and stopped explicitly. | Stopped profiles can wake automatically from stable CDP or viewer endpoints. |
| Idle behavior | Running browsers remain live until explicitly stopped. | Idle Browser Instances can spin down while preserving profile data. |
| Capacity control | Runtime capacity is mostly an operator concern. | `CLOAKHUB_MAX_RUNNING_INSTANCES` limits live instances and can trigger capacity preemption. |
| CDP access | CDP is proxied through the manager for running profiles. | CDP is proxied through CloakHub, uses stable profile URLs, and can be protected per profile with a CDP Token. |
| Process cleanup | Optimized for a single-purpose container. | Cleanup targets CloakHub-owned processes by profile-specific ownership markers. |
| Stack | FastAPI backend plus React/Vite frontend. | Bun backend with a lightweight Bun-served UI. |
| Docker image | Builds a Manager application image. | Uses a registry-first image with bundled CloakBrowser Binary and KasmVNC. |

## Features

- Browser Profile CRUD with CloakBrowser-compatible launch settings, fingerprint settings, proxy,
  locale/timezone, platform, screen, GPU, hardware concurrency, user agent, tags, notes, custom
  launch args, headless mode, clipboard preference, and Sleep Policy.
- Stable profile-level CDP endpoints under `/api/profiles/{profile_id}/cdp`.
- Manual headed viewing through the CloakHub UI and a noVNC-compatible KasmVNC proxy.
- Per-profile CDP Token create, copy, regenerate, and revoke actions.
- Lifecycle history for starts, stops, crashes, launch failures, idle timeouts, and capacity
  preemption.
- Docker and non-Docker Linux operation, with configurable Data Root and browser binary discovery.

## Run

```sh
bun install
bun run start
```

Startup requires a discoverable CloakBrowser Binary. Set `CLOAKHUB_BROWSER_BIN`, provide the packaged Docker path, or install `cloakbrowser` on `PATH`.
Headed Browser Profiles also require KasmVNC `Xvnc`; if it is missing, startup continues with a warning and headed launch/viewer actions fail until `Xvnc` is installed.

## Docker

Docker-first operation uses `/data` as the Data Root and exposes CloakHub on port `7788`:

```sh
docker pull ghcr.io/txchen/cloakhub:latest
docker run --rm \
  -p 127.0.0.1:7788:7788 \
  -v cloakhub-data:/data \
  ghcr.io/txchen/cloakhub:latest
```

Equivalent Docker Compose service:

```yaml
services:
  cloakhub:
    image: ghcr.io/txchen/cloakhub:latest
    environment:
      CLOAKHUB_DATA_DIR: /data
      CLOAKHUB_HOST: 0.0.0.0
      CLOAKHUB_PORT: "7788"
    ports:
      - "7788:7788"
    volumes:
      - ./data:/data
```

The container listens on `0.0.0.0:7788` internally. The published image includes the CloakBrowser Binary at `/opt/cloakbrowser/cloakbrowser` and KasmVNC for headed Browser Profiles.

## Configuration

Defaults:

- `CLOAKHUB_HOST`: `127.0.0.1`
- `CLOAKHUB_PORT`: `7788`
- `CLOAKHUB_DATA_DIR`: `~/.cloakhub/data`
- `CLOAKHUB_MAX_RUNNING_INSTANCES`: `10`

Optional settings:

- `CLOAKHUB_BROWSER_BIN`: path to the CloakBrowser Binary
- `CLOAKHUB_AUTH_TOKEN`: admin auth token for protected UI and admin APIs

Docker deployments should set `CLOAKHUB_HOST=0.0.0.0` and `CLOAKHUB_DATA_DIR=/data`.

The Data Root contains profile data and secrets. Treat it as sensitive storage.

## Tests

Normal tests do not launch real CloakBrowser or KasmVNC:

```sh
bun test
```

Real-runtime integration tests are opt-in and require CloakBrowser plus KasmVNC for headed coverage:

```sh
CLOAKHUB_BROWSER_BIN=/path/to/cloakbrowser bun run integration:real-runtime
```

Those integration tests exercise real headless launch, headed KasmVNC/noVNC startup, CDP Transparent Recovery, spin-down/recovery persistence, and explicit Stop overriding active clients.
