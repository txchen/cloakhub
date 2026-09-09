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
  locale/timezone, platform, screen, GPU, hardware concurrency, user agent, notes, custom
  launch args, headless mode, clipboard preference, and Sleep Policy.
- Stable profile-level CDP endpoints under `/api/profiles/{profile_id}/cdp`.
- Manual headed viewing through the CloakHub UI and a noVNC-compatible KasmVNC proxy.
- Per-profile CDP Token create, copy, regenerate, and revoke actions.
- Persistent event log with profile, event-type, and time-range filters, including
  starts, stops, failures, idle timeouts, CDP sleep blockers, and capacity preemption.
- Last-tab protection for CDP automation: creates an empty tab before closing the last
  page, preserving normal client close events.
- Docker and non-Docker Linux operation, with configurable Data Root and browser binary discovery.

## Automation API

For AI agents and scripts, see the [API guide](docs/api.md) and
[runnable Playwright example](examples/agent-workflow.mjs). The guide covers profile
discovery, start/connect/stop, separate admin and CDP credentials, and retry behavior.
Use `GET /api/profiles?view=summary` for compact discovery; profile and lifecycle
responses include fixed CDP connection URLs.

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
docker pull ghcr.io/txchen/cloakhub:0.4.0
docker run --rm \
  -p 127.0.0.1:7788:7788 \
  -v cloakhub-data:/data \
  ghcr.io/txchen/cloakhub:0.4.0
```

Equivalent Docker Compose service:

```yaml
services:
  cloakhub:
    image: ghcr.io/txchen/cloakhub:0.4.0
    restart: unless-stopped
    shm_size: 2gb
    environment:
      CLOAKHUB_DATA_DIR: /data
      CLOAKHUB_HOST: 0.0.0.0
      CLOAKHUB_PORT: "7788"
      CLOAKHUB_DEFAULT_TIMEZONE: "${CLOAKHUB_DEFAULT_TIMEZONE:-UTC}"
      CLOAKHUB_DEFAULT_LOCALE: "${CLOAKHUB_DEFAULT_LOCALE:-en-US}"
    ports:
      - "7788:7788"
    volumes:
      - ./data:/data
```

The container listens on `0.0.0.0:7788` internally. The published image includes the CloakBrowser Binary at `/opt/cloakbrowser/cloakbrowser` and KasmVNC for headed Browser Profiles.

Images support `linux/amd64` and `linux/arm64`. Pin a full version such as `0.4.0`
for predictable deployments and rollback. The `0.4` alias follows patch releases,
and `latest` follows the newest stable release. Branch builds publish `master`
and `sha-*` development tags without changing `latest`.

To release, update `package.json`, commit and push the changes, and wait for the
Tests workflow to pass. Push a matching Git tag (for example `v0.4.0`) to build
the release images. The image workflow checks that the tag matches the package
version before publishing.

## Configuration

Defaults:

- `CLOAKHUB_HOST`: `127.0.0.1`
- `CLOAKHUB_PORT`: `7788`
- `CLOAKHUB_DATA_DIR`: `~/.cloakhub/data`
- `CLOAKHUB_MAX_RUNNING_INSTANCES`: `10`

Optional settings:

- `CLOAKHUB_BROWSER_BIN`: path to the CloakBrowser Binary
- `CLOAKHUB_AUTH_TOKEN`: admin auth token for protected UI and admin APIs
- `CLOAKHUB_DEFAULT_TIMEZONE`: IANA timezone for new profiles, e.g. `America/Los_Angeles`;
  defaults to the server process timezone (usually UTC in Docker)
- `CLOAKHUB_DEFAULT_LOCALE`: language tag for new profiles; defaults to `en-US`

Docker deployments should set `CLOAKHUB_HOST=0.0.0.0` and `CLOAKHUB_DATA_DIR=/data`.

New profiles default to a Linux identity, headed mode, 1366×768, and four CPU threads.
Headed mode uses ANGLE/SwiftShader for WebGL without requiring a host GPU and supports
unattended CDP automation without opening the viewer. Native headless remains available,
but WebGL is not reliable with every bundled browser build.

Set the deployment timezone to match the browser's internet exit. For a US west-coast
deployment, for example, add `CLOAKHUB_DEFAULT_TIMEZONE=America/Los_Angeles` and
`CLOAKHUB_DEFAULT_LOCALE=en-US` to the container environment (or Compose `.env`).
These values are saved when each profile is created.
The editor shows the saved region and offers **Use deployment region** to explicitly
apply it. A profile using a proxy in another region should set its own timezone/locale.
There is no automatic GeoIP lookup or region change on restart.

Existing profiles keep their stored platform and region, including legacy blank values
that inherit the browser environment. Deployment default changes affect new profiles
only; the updated headed graphics parameters apply on the next browser start. Linux
is the recommended identity for this server; cross-platform identities may need matching
fonts and graphics. These defaults improve consistency, but do not guarantee that a
site cannot identify an automated or modified browser.

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
They also verify that a new default headed profile can render and read pixels through
both WebGL and WebGL2. They do not depend on public bot-detection websites.

## Workspace UI

The workspace is designed for roughly 10–15 profiles. A permanent sidebar lists every profile
by name with its current status. Click a profile to open its viewer, or its controls if headless.
Use the sidebar arrow to collapse or expand it. Drag its right edge to resize, or double-click
the edge to restore the default width. The edge also supports arrow keys, Home, and End.
Width and collapsed state are remembered in your browser; resizing keeps the viewer connected.
The overview shows connection counts, memory observations, and a profile detail panel.
Profile actions are available from the `…` menu and detail panel; the viewer has a **Settings**
button. The editor is loaded on demand and reports server validation errors. Saving settings
and polling every 2.5 seconds update the workspace without reloading an open viewer.
**Close viewer** disconnects only the viewer.

Use **Event log** in the sidebar to inspect past lifecycle events and current automatic
sleep status. An `idle timeout` stop is confirmed only after process cleanup completes.
The log updates every five seconds and retains the latest 100,000 events across restarts;
loading older events pauses automatic history refresh until you click **Refresh events**.

Timezone, language/locale, and website appearance are passed to the browser on its next start.
Clipboard sync is enforced on the clipboard endpoints and incoming VNC clipboard messages;
KasmVNC's native outgoing clipboard preference fully applies on the next start. Automatic GeoIP
and Humanize are SDK features and are not supported by this direct-process runtime. New requests
enabling them are rejected. Profiles with older values show an explicit option in Advanced
settings to remove those unsupported values.

Start, Stop, Restart, Delete, idle stop, and shutdown share a per-profile operation queue.
Concurrent starts wait for the same ready instance. Deletion waits for browser/display teardown
before removing data, and failed cleanup preserves metadata. Normal shutdown first requests
`Browser.close` so browser storage can flush, with process termination as a fallback. Session
restore retains cookies and tabs across automatic stops; live JavaScript state is not retained.

## Frontend development and verification

HTTP routing lives in `src/app.ts`, response presentation in `src/profile-presentation.ts`, and
browser code, templates, and CSS in `src/ui/`. Bun builds the TypeScript browser entries on first
asset request; no separate frontend server or framework is required. Restart the development
server after changing bundled frontend files (the watch command does this for imported modules;
client-only assets may require a manual restart).

```sh
bun run typecheck
bun test
bunx playwright install chromium
bun run test:ui
```

The UI suite uses an isolated SQLite data directory and controlled runtime handles. Set
`CLOAKHUB_TEST_BROWSER=/path/to/chrome` to use an installed browser. It covers create/edit errors,
proxy preservation and removal, lifecycle confirmations, token-copy fallback, sidebar switching,
viewer continuity while editing, external profile changes, and narrow screens. Real browser
persistence and runtime settings remain covered by `bun run integration:real-runtime`.
