# CloakHub API for automation agents

The API manages persistent browser profiles and their running browser processes.
Use Playwright, Puppeteer, or another CDP client to operate pages after connecting.
All paths below are relative to the CloakHub origin, for example `http://server:7788`.

## Credentials

| Credential | Where to send it | Allows |
| --- | --- | --- |
| `CLOAKHUB_AUTH_TOKEN` (admin token) | `Authorization: Bearer ...` on management requests | List/read/create/edit/delete profiles, start/stop/restart, manage CDP tokens |
| Profile CDP token | `Authorization: Bearer ...` on that profile's CDP HTTP and WebSocket requests | Connect to the browser, automatically starting it if needed |

These credentials are separate. A profile token cannot list profiles or call explicit
start/stop. An admin token does not substitute for a configured profile token on CDP.
When admin auth is not configured, management requests need no credentials.
When a profile has no CDP token, **its CDP endpoints are open**, even if admin auth is configured.

CDP also accepts `?token=...`. Prefer the header when the client supports it. If discovery
uses a bearer header, supply that header again when opening its returned WebSocket URL.
If discovery uses a query token, the returned WebSocket URL contains that token.
Connection metadata below never contains credentials. Keep actual tokens out of model
prompts/logs; inject them into the HTTP/CDP client from the execution environment.

## Typical workflow

1. `GET /api/profiles?view=summary` with admin auth. Select an exact `profile_id`.
   `display_name` is useful for selection but is not unique; do not silently pick the
   first match if multiple profiles have the requested name.
2. Read `connection.auth`. If it is `cdp_token`, obtain the credential from your secret
   configuration or `GET connection.cdp_token_url` with admin auth.
3. Connect to `connection.cdp_url` using `chromium.connectOverCDP`, or to
   `connection.cdp_ws_url` using a WebSocket CDP client. This automatically starts the
   browser. Explicit `POST /api/profiles/{id}/start` is also available and returns
   connection metadata after CDP is ready.
4. Operate pages through the CDP client. Reuse the existing browser context for the
   profile's cookies and login state.
5. Disconnect when finished. With Playwright's remote CDP connection, `browser.close()`
   disconnects the client; the server browser continues running until stopped or idle.
   To stop it immediately, call `POST /api/profiles/{id}/stop` with admin auth.

An open CDP session prevents automatic idle shutdown and capacity preemption. Explicit
stop/restart overrides active clients and disconnects everyone using that profile.
There is no task ownership or exclusive lease: coordinate access or dedicate a profile
to a task before stopping it. Stop preserves browser data; DELETE removes it.

### Runnable Playwright example

From this repository after `bun install` (Node 20+ or Bun):

```sh
export CLOAKHUB_URL=http://server:7788
export CLOAKHUB_AUTH_TOKEN=your-admin-token
export CLOAKHUB_PROFILE_ID=research
node examples/agent-workflow.mjs
```

The [example](../examples/agent-workflow.mjs) finds the profile, obtains its CDP token,
starts it, connects using the returned URL, operates a temporary page, and disconnects.
For a profile dedicated to this task, set `CLOAKHUB_STOP_AFTER=true` to also stop it.
The script requires management access; an agent given only a CDP token should instead
connect directly to its preassigned profile's fixed CDP URL.

## Management endpoints

Every endpoint in this table requires admin auth when configured. Responses are JSON,
except successful DELETE responses, which have no body. Do not call `.json()` on 204.

| Method | Path | Success response |
| --- | --- | --- |
| GET | `/api/profiles` | 200, array of full profiles |
| GET | `/api/profile-defaults` | 200, launch defaults used for new profiles; does not start a browser |
| GET | `/api/profiles?view=summary` | 200, array of summaries |
| POST | `/api/profiles` | 201, created full profile |
| GET | `/api/profiles/{id}` | 200, full profile; also accepts `?view=summary` |
| PATCH | `/api/profiles/{id}` | 200, updated full profile |
| DELETE | `/api/profiles/{id}` | 204; stops the browser and deletes profile data |
| POST | `/api/profiles/{id}/start` | 200, lifecycle state after CDP readiness |
| POST | `/api/profiles/{id}/stop` | 200, lifecycle state after teardown |
| POST | `/api/profiles/{id}/restart` | 200, lifecycle state after restart and CDP readiness |
| GET | `/api/profiles/{id}/cdp-token` | 200, token state, including plaintext token or null |
| POST | `/api/profiles/{id}/cdp-token` | 201, existing token or a newly created one |
| POST | `/api/profiles/{id}/cdp-token/regenerate` | 200, new token; old token no longer authenticates new connections |
| DELETE | `/api/profiles/{id}/cdp-token` | 204; removes protection from that profile's CDP endpoints |

`GET /api/health` returns `{"ok":true}` without auth. It reports service availability,
not browser readiness or available capacity. `/api/auth/login` is for UI cookies;
agents should send bearer headers directly, without a login step.

### Profile summaries and connection metadata

```json
{
  "profile_id": "research",
  "display_name": "Research browser",
  "notes": "Research account",
  "headless": true,
  "instance_status": "stopped",
  "cdp_session_count": 0,
  "manual_viewer_count": 0,
  "last_launch_error": null,
  "connection": {
    "cdp_url": "http://server:7788/api/profiles/research/cdp",
    "cdp_ws_url": "ws://server:7788/api/profiles/research/cdp",
    "cdp_discovery_url": "http://server:7788/api/profiles/research/cdp/json/version",
    "auth": "cdp_token",
    "cdp_token_url": "http://server:7788/api/profiles/research/cdp-token"
  }
}
```

`connection.auth` is `none` or `cdp_token`. Connection URLs remain valid while stopped
and automatically start the profile when used. Full profile responses include the same
connection object, plus configuration, lifecycle timestamps, sleep policy and runtime
observations. They omit the CDP token, but include proxy configuration with credentials;
use summaries for agent discovery. Listing or reading profiles does not wake browsers
or count as browser activity. Summaries also avoid scanning process resource usage.

`instance_status` is `stopped`, `starting`, `running`, `stopping`, or `failed`.
Lifecycle responses contain `profile_id`, `instance_status`, and `connection`.
They also retain `status`, an alias of `instance_status`, for existing clients.
Token responses contain `profile_id`, `cdp_token` (string or null), and
`cdp_token_configured` (boolean).

### Creating and editing profiles

Send `Content-Type: application/json`. The minimal create body is
`{"profile_id":"research"}`. IDs must match `^[a-z][a-z0-9_]*$` and cannot be renamed.
Profiles default to headed mode; specify `"headless":true` for automation-only use.
New profiles use a Linux identity, 1366×768, and four CPU threads. Omitted `timezone`
and `locale` are copied from the deployment defaults and persisted. Query
`GET /api/profile-defaults` before creation to preview them. The editor uses the same
defaults through its cookie-authenticated `/ui/profile-defaults` endpoint. Neither
endpoint contains a fingerprint seed for an existing profile or any credentials.

Configure `CLOAKHUB_DEFAULT_TIMEZONE` for the deployment's internet exit and
`CLOAKHUB_DEFAULT_LOCALE` for its language. Without configuration, the timezone is the
server process timezone (usually UTC in Docker) and the locale is `en-US`. Explicit
profile values override these defaults; explicit empty strings preserve the ability
to inherit the browser environment. Updating deployment defaults never migrates
existing profiles. Use per-profile regional settings for proxies in another region.

Common optional create/PATCH fields:

| Field | Type / meaning |
| --- | --- |
| `display_name`, `notes` | Strings; use notes to explain which account or task a profile serves |
| `headless`, `clipboard_sync` | Booleans |
| `timezone`, `locale` | IANA timezone and language tag, e.g. `America/Los_Angeles`, `en-US` |
| `proxy` | Proxy URL with an explicit port; `""` removes it; omission preserves it |
| `sleep_policy` | `{"mode":"default"}`, `{"mode":"never"}`, or `{"mode":"minutes","minutes":30}` (1–1440) |
| `color_scheme` | `light`, `dark`, or `system` |
| `fingerprint_seed`, `platform`, `user_agent`, `gpu_vendor`, `gpu_renderer` | Strings |
| `screen_width`, `screen_height` | Integers, 100–10000 |
| `hardware_concurrency` | Integer, 1–256 |
| `custom_launch_args` | Array of strings; cannot override CloakHub-owned data-directory, debugging, or window flags |

PATCH changes stored configuration; launch-setting changes take effect on the next
start/restart. It does not restart a running browser. Humanize and automatic GeoIP are
not launch options supported by this runtime. Configure human-like actions in your
automation client, and set timezone/locale explicitly.

### Automation and graphics

The default headed profile supports unattended CDP automation with no viewer connected.
Its software graphics backend supports WebGL in the packaged Linux environment. Native
headless is still supported, but some browser builds cannot initialize WebGL there.
Custom launch arguments can override graphics settings; doing so may change fingerprint
consistency. Existing stored platform/region settings are not changed by an upgrade.

Prefer Playwright locators for routine element operations. Avoid `page.exposeFunction`
when a page-to-client callback is unnecessary: its injected binding can reveal the
automation client. `page.evaluate` executes in the page's main world, where page code
can observe some calls. Use an isolated world deliberately when appropriate; frame
navigation changes execution contexts. Isolation does not make all interactions
undetectable. CloakHub forwards these commands transparently and does not rewrite
client scripts or supply SDK Humanize behavior.

## CDP endpoints

These use profile CDP auth, not admin auth:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/profiles/{id}/cdp` or `/cdp/json/version` | Chrome-compatible version/discovery object containing `webSocketDebuggerUrl` |
| GET | `/api/profiles/{id}/cdp/json` or `/cdp/json/list` | Chrome-compatible array of browser targets |
| WebSocket | `/api/profiles/{id}/cdp` | Stable browser CDP connection |
| WebSocket | URL returned by discovery | Connection to that particular browser/target |

Discovery can start a stopped profile, so use the profile GET endpoint for passive
status polling. Browser UUIDs and target IDs in discovery URLs are specific to a
browser lifetime. Reconnect through the fixed profile endpoint after stop/restart;
existing CDP sessions and in-flight commands are not automatically resumed.

URLs reflect the request's public origin. Reverse proxies must set `X-Forwarded-Host`
and `X-Forwarded-Proto` to the externally reachable host/port and scheme, and support
WebSocket upgrades. Mount CloakHub at the origin root; path-prefix hosting is not
supported. The proxy should overwrite forwarded headers supplied by external clients.

## Errors, retries, and timeouts

API errors, including routing/authentication and failed WebSocket handshakes, use:

```json
{
  "error": "Browser Profile \"missing\" was not found",
  "code": "PROFILE_NOT_FOUND",
  "message": "Browser Profile \"missing\" was not found",
  "retryable": false
}
```

`error` is retained as an alias of `message` for existing clients. Branch on `code`,
not the wording of the message. A WebSocket library may hide a failed handshake's
JSON body; explicit HTTP start/discovery is useful when diagnosing connection failures.

| Code | HTTP | Agent action |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Correct the request/settings |
| `UNAUTHORIZED` | 401 | Check which credential the endpoint requires |
| `PROFILE_NOT_FOUND` | 404 | Correct the ID or refresh the profile list; do not retry unchanged |
| `NOT_FOUND`, `METHOD_NOT_ALLOWED` | 404 / 405 | Correct the endpoint/method |
| `PROFILE_ALREADY_EXISTS` | 409 | Read the existing profile and verify it is the intended one |
| `CAPACITY_UNAVAILABLE` | 503 | `retryable:true`; use bounded backoff with jitter or wait for capacity |
| `DISPLAY_UNAVAILABLE` | 503 | Headed runtime dependency is unavailable; requires configuration repair |
| `BROWSER_START_FAILED`, `BROWSER_STOP_FAILED`, `BROWSER_RESTART_FAILED` | 500 | Inspect profile state/errors; do not blindly repeat |
| `CDP_UNAVAILABLE` | 503 | Inspect profile state and connection; `retryable:false` |
| `DATA_DELETE_FAILED`, `INTERNAL_ERROR` | 500 | Inspect state and server; do not blindly repeat |

Only explicitly retryable responses invite automatic retries. A 503 alone does not.
Start/stop are idempotent in effect: starting a running browser keeps it running,
and stopping an already stopped profile succeeds. Concurrent starts share readiness.
Restart is not idempotent; replaying it disconnects clients again. Token regeneration
also must not be blindly replayed. Profile creation is unique by ID: after a lost
response, GET that ID and verify its configuration before retrying creation.

Allow enough time for cold browser startup and teardown (a 60-second client timeout
is a reasonable starting point). A client timeout/disconnect does not cancel the
server operation. Read profile state after an ambiguous timeout; retry start/stop
only when appropriate. Coordinate concurrent users even for idempotent operations.

## Last-tab protection

CloakHub protects tab-close commands sent through its CDP WebSocket proxy. Before
closing the last ordinary page, it creates a new `about:blank` page and then forwards
the original close command. The original page really closes, so Playwright's
`page.close()` and close events retain their normal meaning. Close requests from
multiple clients are serialized per profile. Targets already acknowledged as closing
are excluded from the next count, even if destruction or a beforeunload dialog is pending.
A cancelled beforeunload can therefore leave an extra blank tab.

This covers `Target.closeTarget` and `Page.close` (flattened sessions or direct page
WebSockets). Protection failure returns a CDP error rather than deliberately closing
the last page without a replacement; refresh the target list after an ambiguous close.
Legacy nested `Target.sendMessageToTarget`, page JavaScript, and manual window closes
are outside this protection. Explicit `Browser.close` and CloakHub Stop/Restart still
close the browser. HTTP `/json/close/...` is rejected; use the protected WebSocket commands.
The internal protection connection is short-lived and does not count as a sleep blocker.

## Event history

`GET /api/events` requires admin auth when configured. The workspace's **Event log**
page uses the same history via UI authentication. Filters are optional:

- `profile_id`: exact ID, including a deleted profile's ID.
- `type`: exact event type, such as `sleep.timeout`, `sleep.blocked`, or `browser.stopped`.
- `since`, `until`: inclusive ISO timestamps; use an explicit timezone.
- `limit`: 1–200, default 100.
- `before`: cursor from `next_before` to load older records.

The response is `{ "events": [...], "next_before": 123 }`, with `next_before: null`
at the end. Each event has `id`, `occurred_at` (UTC), `profile_id` (null for the hub),
`type`, `level`, `message`, and structured `details`. Results are newest-recorded first;
the ID cursor remains stable when timestamps match or new events arrive.

History is stored in `events.sqlite` under the Data Root and survives server restarts
and profile deletion. It retains the latest 100,000 events and begins when this feature
is enabled; old profile timestamps are not reconstructed into historical events.
Page contents, cookies, credentials, and raw CDP messages are not logged.

To diagnose idle shutdown, look for `sleep.timeout` followed by `browser.stopped` with
`details.reason: "idle timeout"`. A timeout event only indicates that stopping began;
`browser.stop_failed` means process cleanup did not complete and a later idle sweep
will retry. Open external CDP sessions block sleep even without traffic. After they
disconnect, the countdown uses the last recorded activity, so an already-expired
browser may stop on the next sweep. The server checks every 5 seconds. Blocker and
policy changes are recorded on observation instead of logging every sweep. Manual
input resets are throttled to once per 5 seconds, matching runtime activity tracking.
Reading history and polling profile status never wake or keep a browser alive.
