# CloakHub v1 PRD

## Summary

CloakHub is a Linux-focused, Bun-based manager for persistent CloakBrowser profiles and on-demand browser runtimes. It keeps the useful profile-management, VNC viewer, and CDP automation features from CloakBrowser Manager, but improves long-running server efficiency by spinning down browser/display processes when they are not actively used and transparently recovering them when CDP or manual access returns.

The primary reference study is [refs/cloakbrowser-manager.md](../refs/cloakbrowser-manager.md). Domain language is defined in [CONTEXT.md](../CONTEXT.md), and architectural decisions live in [docs/adr](./adr).

## Goals

- Preserve Browser Persistence across Browser Instance stop, restart, spin-down, crash, and Transparent Recovery.
- Reclaim CPU and RAM by stopping idle Browser Instances, including browser, KasmVNC/display, clipboard, and support processes.
- Let CDP Clients use stable profile-level CDP URLs that wake stopped Browser Instances automatically.
- Keep manual browser viewing through a noVNC-style UI.
- Keep setup simple with a Bun backend and a lightweight Bun-served frontend.
- Support Linux and Docker-first operation, while still allowing non-Docker Linux testing.
- Make resource and activity state visible enough that operators can understand why an instance is running or stopped.

## Non-goals

- No Windows or macOS runtime support.
- No multi-replica/shared-Data-Root deployment.
- No Python backend dependency.
- No runtime CloakBrowser binary download.
- No startup auto-launch.
- No profile import/export, profile cloning, or automated CloakBrowser Manager migration in v1.
- No first-class extension manager; extensions are supported only through allowed custom launch args.
- No built-in TLS; use a reverse proxy for HTTPS.
- No full UI log viewer; use Docker/process logs for detail.
- No OpenAPI requirement in v1.
- No automatic update checks or runtime telemetry.

## Core Concepts

- A `Browser Profile` is durable. It stores profile metadata and has a persistent user-data directory under the configured Data Root.
- A `Browser Instance` is runtime-only. It is the live browser process plus display, VNC, CDP, clipboard, ports, process group, and supervision state.
- Browser Persistence means durable browser user-data survives. It does not preserve JavaScript heap, in-flight requests, unsaved form state, media playback, or exact runtime memory.
- A `Profile ID` is user-chosen, immutable, unique, and URL-safe with pattern `^[a-z][a-z0-9_]*$`.
- A `Sleep Policy` controls when a profile's instance may spin down.

## Profile Model

Each Browser Profile must include:

- `profile_id`: required, immutable, lower-case with underscores, used in URLs and filesystem paths.
- `display_name`: optional, defaults from `profile_id`, editable.
- CloakBrowser Manager-compatible launch/profile fields:
  - fingerprint seed
  - proxy
  - timezone, locale, geoip
  - platform
  - screen width and height
  - GPU vendor and renderer
  - hardware concurrency
  - user agent
  - color scheme
  - humanize and human preset, subject to implementation-time CloakBrowser CLI verification
  - headless
  - clipboard sync preference, default on
  - custom launch args
  - tags with optional colors
  - notes
- Sleep Policy:
  - global default
  - per-profile timeout override
  - explicit never-sleep option
- Optional per-profile CDP Token:
  - disabled by default
  - one active token per profile in v1
  - plaintext storage by explicit decision
  - regenerate and revoke actions

Profile user-data directories are created at profile creation:

```text
${CLOAKHUB_DATA_DIR}/profiles/{profile_id}
```

Profile defaults such as diagnostic bookmarks and search preferences should be written at creation when enabled, idempotently and without overwriting existing browser files.

## Runtime State And Status

Instance Status values:

- `stopped`
- `starting`
- `running`
- `stopping`
- `failed`

Runtime State is in memory only:

- active CDP sessions
- viewer connections
- process handles and process groups
- allocated display/ports
- launch locks
- idle timers
- sleep countdowns

SQLite persists metadata and Lifecycle History only:

- last started time
- last stopped time
- last activity time
- last stop reason
- last launch failure time
- last launch error

On CloakHub restart, the process must clean up only Owned Processes, mark all instances stopped, and recover instances later on demand.

## Activity And Spin-down Rules

Default idle timeout is 30 minutes.

Instance Activity includes:

- active CDP websocket connections
- client-to-browser CDP messages through CloakHub
- CDP HTTP discovery requests as short activity
- Manual Input through VNC: keyboard, pointer, wheel, clipboard paste, and similar input
- explicit lifecycle commands

Instance Activity excludes:

- passive UI polling
- health checks
- profile list/status requests
- profile edits
- open VNC viewer presence by itself
- server-to-client VNC framebuffer updates
- browser-internal page work such as timers, media, downloads, service workers, or page WebSockets
- passive clipboard polling

CDP and VNC are intentionally asymmetric:

- An open CDP Session blocks spin-down indefinitely in v1.
- An open VNC viewer does not block spin-down unless it sends Manual Input.
- Viewer-only sessions may be disconnected by idle spin-down or capacity preemption.

Manual Input activity should be inferred by the backend from client-to-server RFB messages in the VNC proxy, not trusted from a separate frontend signal. Pointer movement counts as Manual Input, but activity updates should be throttled, for example at most once every 5 seconds.

Spin-down must:

1. Close/proxy-disconnect affected clients when needed.
2. Gracefully close the browser first.
3. Wait a short grace period.
4. Stop display/VNC/helpers.
5. Hard-kill remaining Owned Processes if needed.
6. Persist the stop reason and timestamps.

Stop reasons should include at least:

- manual stop
- idle timeout
- capacity preemption
- restart
- crash
- launch failure

## Transparent Recovery

Transparent Recovery starts a stopped Browser Instance when a wake-capable endpoint is accessed, then waits until the requested endpoint is usable.

Wake-capable paths:

- stable CDP URL and CDP discovery endpoints
- manual viewer open
- explicit start/restart API

Non-wake paths:

- `/api/health`
- profile list/status polling
- profile edits
- passive system status

Recovery behavior:

- Authenticate before wake.
- Serialize launch/recovery per Browser Profile.
- Concurrent requests for the same stopped profile share one launch attempt.
- If launch succeeds, clear `failed` status while preserving last failure details in Lifecycle History until replaced.
- If launch fails, mark `failed` or `stopped` as appropriate, persist launch error and timestamp, return a clear error, and do not retry in a loop.
- CDP/manual clients are not transparently reattached after browser crash or restart; they must reconnect.

Stable CDP URLs use Profile ID:

```text
/api/profiles/{profile_id}/cdp
/api/profiles/{profile_id}/cdp/json/version
/api/profiles/{profile_id}/cdp/json/list
/api/profiles/{profile_id}/cdp/devtools/{path}
```

CDP discovery responses should stay Chrome-compatible and only rewrite websocket URLs through CloakHub.

## Capacity Management

Default `CLOAKHUB_MAX_RUNNING_INSTANCES` is 10.

The Running Instance Limit applies to both headed and headless instances.

When capacity is full:

- Never preempt an instance with active CDP Sessions.
- Never preempt an instance with Manual Input in the last 60 seconds.
- May preempt a viewer-only instance.
- May preempt a never-sleep profile if it has no active CDP Session and no Manual Input in the last 60 seconds.
- Pick least-recently-active eligible instance.
- Persist stop reason as capacity preemption.
- If no instance is eligible, reject recovery/start with a retryable capacity error.

No profile priority or reserved capacity exists in v1.

## Process And Display Runtime

CloakHub is the supervisor for all Browser Instance child processes.

Runtime requirements:

- Bun backend owns process launch and supervision.
- No Python backend.
- One display/VNC runtime per headed Browser Instance.
- Headless instances skip KasmVNC/display entirely and are CDP-only.
- KasmVNC `Xvnc` is the v1 display runtime.
- noVNC-style client is used in the web UI.
- RFB compatibility proxy is required between noVNC and KasmVNC.
- RFB proxy must handle filtering/rewriting and clipboard translation inherited from the reference design.

Internal resources:

- Use loopback TCP ports for internal CDP and VNC.
- Use fixed internal ranges in v1 and validate max running instances against them.
- Keep Chrome CDP ports private and never expose them directly to clients.
- Use one process group per Browser Instance for cleanup and Resource Usage attribution.
- Use pidfiles, profile-specific paths, process groups, or launch markers to identify Owned Processes.
- Never use broad process-name cleanup such as `pkill chrome` or `pkill Xvnc`.

Missing dependency behavior:

- Missing CloakBrowser Binary is a startup failure.
- Missing/unusable Data Root is a startup failure.
- Missing KasmVNC is a startup warning, but headed profile launch/view fails until fixed.
- Non-Docker operation requires the operator to install CloakBrowser and KasmVNC.

## Browser Binary

CloakHub supports only CloakBrowser, not stock Chrome or Chromium.

Discovery order:

1. `CLOAKHUB_BROWSER_BIN`
2. known packaged Docker path
3. `cloakbrowser` executable on `PATH` for development

CloakHub does not download the binary at runtime. Docker images may download/provide it during image build.

## Storage

Use SQLite for metadata under Data Root. Browser state remains in per-profile user-data directories.

Data Root:

- env var: `CLOAKHUB_DATA_DIR`
- default when unset: `~/.cloakhub/data`
- Docker can set `CLOAKHUB_DATA_DIR=/data`

Data Root contains secrets, including proxy credentials and plaintext CDP Tokens, and must be treated as sensitive.

SQLite stores:

- profile metadata
- tags
- Sleep Policy
- CDP Token
- Lifecycle History fields
- global settings if not env-only

SQLite does not store:

- live process handles
- active websocket counts as durable truth
- display/port allocations as durable truth
- timers

## Security

Admin auth:

- Optional `CLOAKHUB_AUTH_TOKEN`.
- Protects UI and admin APIs only.
- Supports login cookie for UI.
- Supports bearer token for admin API clients.
- Does not grant CDP access.

CDP auth:

- Per-profile CDP Token is separate from admin auth.
- CDP Token protects only that profile's CDP endpoints.
- CDP Token does not grant UI/admin API access.
- If a profile has no CDP Token, its CDP endpoint is open to anyone who can reach CloakHub.
- UI must visibly warn when CDP is open.
- CDP Token may be sent as bearer token or `?token=...`.
- Token-bearing URLs should be copied only by explicit action and shown with leakage warning.
- Token management endpoints require admin auth.

VNC/manual viewer auth:

- Admin auth only.
- No per-profile VNC token in v1.

Redaction:

- Proxy credentials must be masked in UI by default.
- Proxy credentials must be redacted from logs/errors.
- CDP Tokens must be redacted from logs/errors even though stored plaintext.

Health:

- `GET /api/health` bypasses auth.
- It returns minimal non-sensitive health, such as `{ "ok": true }`.
- It never wakes or keeps alive any Browser Instance.

## API Requirements

Public API resource path is `/api/profiles`.

Profile/admin APIs, protected by admin auth when configured:

- create/list/read/update/delete profiles
- explicit start
- explicit stop
- restart
- runtime/status observations
- clipboard endpoints for manual UI use
- CDP Token create/regenerate/revoke/view

Lifecycle APIs:

- explicit stop is an operator override and may close active CDP/VNC clients
- restart is stop then start and disconnects clients
- deleting a running profile first stops it
- delete removes user-data directory before deleting metadata
- if teardown or filesystem deletion fails, keep metadata visible

CDP endpoints:

- use `/api/profiles/{profile_id}/cdp...`
- authenticate with CDP Token only when profile has one
- trigger Transparent Recovery after auth
- keep Chrome-compatible discovery shape with rewritten URLs

Profile API responses should include runtime observations:

- Instance Status
- active CDP session count and durations
- active CDP session remote address and optional user agent/header metadata
- viewer count
- last activity
- sleep countdown or blocker
- approximate Resource Usage
- last stop reason
- last launch error

## UI Requirements

The v1 UI is an operational dashboard, not a marketing surface.

Technology:

- Bun-served TypeScript/JSX and small client-side modules by default.
- No React unless necessary UI complexity justifies it.
- Poll profile/runtime status every 2-3 seconds plus immediate refresh after actions.

Core UI:

- profile list
- create/edit profile form
- basic search by name/tag
- sorting/grouping by status and last activity
- profile status panel
- noVNC viewer for headed profiles
- explicit Start, Stop, Restart actions
- Open Viewer triggers Transparent Recovery
- CDP URL copy action
- CDP Token management
- resource usage display
- sleep countdown and blockers
- active CDP session list with durations and minimal connection metadata
- viewer count and last Manual Input time
- last stop reason / launch error display

Important copy/behavior:

- Use `stopped` consistently, not `sleeping`.
- Distinguish `Spin-down` as automatic stop cause and `Stop` as explicit command.
- Warn when a CDP endpoint is open because no CDP Token exists.
- Warn when copying token-bearing CDP URLs.
- Warn/confirm explicit stop when active CDP sessions or viewers exist.
- For headless profiles, viewer access shows viewer unavailable and points to profile edit/start options; it must not silently override headless.

## Configuration

Environment variables:

- `CLOAKHUB_DATA_DIR`, default `~/.cloakhub/data`
- `CLOAKHUB_BROWSER_BIN`
- `CLOAKHUB_AUTH_TOKEN`
- `CLOAKHUB_HOST`, default `127.0.0.1` outside Docker
- `CLOAKHUB_PORT`, default `7788`
- `CLOAKHUB_MAX_RUNNING_INSTANCES`, default `10`

Docker defaults:

- expose port `7788`
- set host to `0.0.0.0` inside container
- example host mapping should be `127.0.0.1:7788:7788`
- set `CLOAKHUB_DATA_DIR=/data`

Timing defaults:

- global idle timeout: 30 minutes
- manual input protection window for capacity preemption: 60 seconds
- spin-down graceful close timeout: implementation-defined short timeout, recommended around 10 seconds

## Validation

Server validation is authoritative. UI validation is for ergonomics.

Validate:

- `profile_id` pattern and uniqueness
- immutable `profile_id`
- proxy syntax
- screen dimensions
- idle timeout ranges
- max running instances within internal resource ranges
- launch args

Custom launch args are allowed but must not override CloakHub-owned supervision settings, including:

- `--user-data-dir`
- `--remote-debugging-port`
- `--remote-debugging-address`
- any flag that changes profile dir or CDP ownership

Per-profile environment variables are out of scope in v1.

## Testing Strategy

Mandatory unit tests:

- profile validation
- SQLite repository and migrations
- Sleep Policy resolution
- lifecycle manager with fake clock and fake processes
- launch serialization per profile
- idle spin-down rules
- capacity preemption rules
- restart/stop/delete behavior
- auth-before-wake behavior
- CDP Token scoping
- CDP discovery URL rewriting
- RFB compatibility parsing/filtering/rewriting
- Manual Input detection from client-to-server RFB traffic
- redaction of proxy credentials and CDP Tokens

Integration tests:

- opt-in local/Docker script for real CloakBrowser launch
- headed launch with KasmVNC/noVNC path
- headless CDP-only launch
- Transparent Recovery from CDP discovery and CDP websocket
- spin-down then recovery preserving browser user-data
- explicit stop overriding active clients

Normal CI does not need to launch real CloakBrowser/KasmVNC unless the environment is controlled.

## Open Implementation Checks

- Verify exact CloakBrowser CLI flags for humanize/human preset, geoip, fingerprint, platform, GPU, screen, color scheme, and user agent.
- Verify whether KasmVNC version choice changes any RFB compatibility requirements.
- Choose Bun HTTP/router structure and SQLite access pattern.
- Define the exact JSON response shapes for profile/runtime APIs.
- Define exact token generation format and redaction helper.
