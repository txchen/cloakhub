# CloakBrowser Manager research notes

Primary source reviewed: `/home/txchen/code/github/CloakBrowser-Manager` at commit `a85b213`, including README, backend source, frontend source, Docker files, binary license, and tests. No secondary write-ups were used.

## What it is

CloakBrowser Manager is a self-hosted web UI and API for creating, editing, launching, viewing, and automating isolated CloakBrowser profiles. The README describes each profile as an isolated CloakBrowser instance with its own fingerprint, proxy, cookies, and session data; profiles persist across restarts and the default deployment runs everything in one Docker container. Sources: `/home/txchen/code/github/CloakBrowser-Manager/README.md:5`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:26`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:57`.

The product surface is:

- Profile CRUD with fingerprint, network, hardware, behavior, tags, launch args, notes, clipboard, and auto-launch settings.
- One-click launch and stop for each browser.
- Live in-browser viewing through noVNC/KasmVNC.
- CDP proxy endpoints so Playwright/Puppeteer can automate a running profile while it is visible in the UI.
- Optional single-token authentication for the UI, REST API, VNC websocket, and CDP websocket. Sources: `/home/txchen/code/github/CloakBrowser-Manager/README.md:59`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:64`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:119`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:156`.

## High-level architecture

The system is a single FastAPI backend plus a React/Vite/Tailwind SPA. In production, FastAPI serves the compiled SPA and all backend APIs from the same origin. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:1`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:389`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:1021`.

Backend modules:

| File | Responsibility |
| --- | --- |
| `backend/main.py` | FastAPI app, auth middleware, profile REST routes, launch/stop/status routes, clipboard endpoints, VNC websocket proxy, CDP HTTP/websocket proxy, static SPA serving. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:139`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:438`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:677`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:845`. |
| `backend/browser_manager.py` | In-process runtime registry for launched profiles; launch/stop orchestration; CDP port allocation; fingerprint arg construction; first-launch Chrome profile defaults. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:149`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:158`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:167`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:379`. |
| `backend/vnc_manager.py` | Allocates X display numbers and websocket ports; starts/stops KasmVNC `Xvnc`; cleans stale VNC processes. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:21`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:29`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:39`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:119`. |
| `backend/database.py` | SQLite schema, profile CRUD, tags, JSON `launch_args`, manual migrations. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:14`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:30`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:87`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:172`. |
| `backend/models.py` | Pydantic contracts for profile creation/update/response, launch/status, clipboard, and login. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/models.py:10`, `/home/txchen/code/github/CloakBrowser-Manager/backend/models.py:70`, `/home/txchen/code/github/CloakBrowser-Manager/backend/models.py:108`, `/home/txchen/code/github/CloakBrowser-Manager/backend/models.py:129`. |

Frontend modules:

| File | Responsibility |
| --- | --- |
| `frontend/src/lib/api.ts` | Typed fetch wrapper for auth, profiles, lifecycle, status, and clipboard endpoints. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/lib/api.ts:5`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/lib/api.ts:91`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/lib/api.ts:110`. |
| `frontend/src/hooks/useProfiles.ts` | Profile state hook; loads profiles, polls every 3 seconds, and wraps create/update/delete/launch/stop actions. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/hooks/useProfiles.ts:4`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/hooks/useProfiles.ts:21`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/hooks/useProfiles.ts:28`. |
| `frontend/src/App.tsx` | Auth gate, sidebar/main layout, create/edit/view mode switching, top-bar launch/stop integration. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/App.tsx:19`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/App.tsx:91`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/App.tsx:154`. |
| `frontend/src/components/ProfileForm.tsx` | Profile editor for basic identity, network, hardware, behavior, tags, launch args, and notes. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:55`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:204`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:534`. |
| `frontend/src/components/ProfileViewer.tsx` | Dynamic noVNC viewer, CDP URL copy, fullscreen, and clipboard sync logic. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:15`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:28`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:242`. |

## Runtime flow

### Startup

1. The Docker entrypoint creates `/data/profiles`, kills stale `Xvnc`, CloakBrowser/Chromium, and `xclip` processes, removes stale Chrome singleton locks and X11 locks, then starts `uvicorn backend.main:app --host 0.0.0.0 --port 8080`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/entrypoint.sh:4`, `/home/txchen/code/github/CloakBrowser-Manager/entrypoint.sh:7`, `/home/txchen/code/github/CloakBrowser-Manager/entrypoint.sh:21`.
2. FastAPI lifespan initializes SQLite, calls stale cleanup, schedules async auto-launch for profiles with `auto_launch=True`, and on shutdown cancels auto-launch if needed and stops all managed browsers. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:375`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:342`.

### Creating a profile

1. `POST /api/profiles` validates the request with `ProfileCreate`, converts tags to plain dicts, and calls `db.create_profile`. Source: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:452`.
2. `create_profile` generates a UUID, chooses a random 10000-99999 fingerprint seed if none is provided, assigns `/data/profiles/{profile_id}` as the browser user data directory, stores metadata in SQLite, stores tags separately, and returns the hydrated profile. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:87`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:92`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:98`.

### Launching a profile

1. `POST /api/profiles/{profile_id}/launch` loads the persisted profile, rejects missing or already-running profiles, and maps `ValueError` from launch validation to HTTP 400. Source: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:525`.
2. `BrowserManager.launch` uses an async lock plus `_launching` set to prevent duplicate concurrent launches. Source: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:160`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:171`.
3. It allocates a VNC display and websocket port, then allocates a CDP port from a rotating `5100-5199` range. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:176`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:179`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:364`.
4. It removes stale Chromium singleton files from the profile directory and initializes default bookmarks plus DuckDuckGo preferences on first launch. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:186`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:56`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:124`.
5. It starts KasmVNC `Xvnc` on the allocated display, binding its websocket interface to `127.0.0.1`, with raw VNC TCP disabled. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:196`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:53`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:62`.
6. It builds fingerprint flags, appends user-supplied launch args, appends `--remote-debugging-port={cdp_port}`, normalizes/validates the proxy, then calls `cloakbrowser.launch_persistent_context_async` using the profile's `user_data_dir` and `DISPLAY=:{display}`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:204`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:209`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:217`.
7. It injects a clipboard helper script into pages, registers a context close handler, and records a `RunningProfile` in memory. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:236`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:259`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:267`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:272`.

### Viewing and automation

1. The UI polls `GET /api/profiles` every 3 seconds and switches to viewer mode after a successful launch. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/hooks/useProfiles.ts:21`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/App.tsx:130`.
2. `ProfileViewer` dynamically imports `@novnc/novnc`, connects to `/api/profiles/{profile_id}/vnc` with binary websocket protocol, enables viewport scaling, and renders a toolbar for connection status, CDP URL copy, clipboard sync, and fullscreen. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:28`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:35`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:242`.
3. The backend VNC websocket validates origin, connects to KasmVNC at `ws://127.0.0.1:{ws_port}/websockify`, forwards the first RFB handshake frames unchanged, then filters/re-writes later RFB client frames for KasmVNC compatibility. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:677`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:696`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:723`.
4. CDP HTTP endpoints proxy Chrome's `/json/version` and `/json/list` from the internal CDP port, rewriting `webSocketDebuggerUrl` fields so clients connect back through Manager endpoints. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:858`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:876`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:883`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:903`.
5. CDP websocket routes proxy browser-level and page-level websocket traffic to the internal Chrome CDP websocket without protocol translation. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:914`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:974`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:1002`.

## Persistence model

The durable state root is `/data`. SQLite lives at `/data/profiles.db`, and each browser's persistent user data directory lives under `/data/profiles/{profile_id}`. Docker declares `/data` as a volume; Compose maps `~/.cloakbrowser-manager:/data`; README examples use a named Docker volume called `cloakprofiles`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:14`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:94`, `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:62`, `/home/txchen/code/github/CloakBrowser-Manager/docker-compose.yml:6`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:28`.

The `profiles` table stores profile identity and launch configuration: name, seed, proxy, timezone, locale, platform, user agent, screen size, GPU info, hardware concurrency, humanization, headless, geoip, clipboard sync, auto-launch, color scheme, notes, user data directory, timestamps, and JSON `launch_args`. Tags are stored in `profile_tags` with `ON DELETE CASCADE`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:34`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:61`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:126`.

SQLite connections enable WAL mode and foreign keys. Migrations are simple runtime `ALTER TABLE` checks for newer fields like `clipboard_sync`, `launch_args`, and `auto_launch`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:18`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:22`, `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:70`.

Runtime state is not persisted. Running browsers live only in `BrowserManager.running`, a dict from profile id to `RunningProfile`. On backend restart, running state is rebuilt only by `auto_launch` or manual launch. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:149`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:160`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:342`.

## Profile and fingerprint model

The profile form and backend model expose:

- Basic: name, platform, fingerprint seed.
- Network: proxy, timezone, locale, geoip.
- Hardware: screen width/height, hardware concurrency, GPU vendor/renderer.
- Behavior: humanize, human preset, headless, clipboard sync, auto-launch, color scheme, user agent.
- Metadata: tags, launch args, notes. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/models.py:10`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:204`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:277`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:322`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:413`.

`BrowserManager._build_fingerprint_args` translates profile fields into CloakBrowser/Chromium flags including `--fingerprint`, `--fingerprint-platform`, `--fingerprint-gpu-vendor`, `--fingerprint-gpu-renderer`, `--fingerprint-hardware-concurrency`, `--fingerprint-screen-width`, and `--fingerprint-screen-height`. It always adds `--disable-infobars`, `--test-type`, and `--use-angle=swiftshader`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:379`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_browser_manager.py:97`.

Proxy strings are normalized before launch. Already-schemed `http://`, `https://`, and `socks5://` values pass through; `host:port:user:pass` becomes `http://user:pass@host:port`; `host:port` becomes `http://host:port`. Validation requires scheme, hostname, and port. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:22`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:41`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_browser_manager.py:24`.

On first launch, the manager writes default Chrome bookmarks for detection/fingerprint/header/reCAPTCHA test sites and creates a Preferences file making DuckDuckGo the default search provider if the files do not already exist. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:56`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:124`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_browser_manager.py:234`.

## API surface

Auth:

- `GET /api/auth/status`
- `POST /api/auth/login`
- `POST /api/auth/logout`

Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:396`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:408`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:426`.

Profiles:

- `GET /api/profiles`
- `POST /api/profiles`
- `GET /api/profiles/{profile_id}`
- `PUT /api/profiles/{profile_id}`
- `DELETE /api/profiles/{profile_id}`

Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:438`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:452`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:469`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:482`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:500`.

Lifecycle and status:

- `POST /api/profiles/{profile_id}/launch`
- `POST /api/profiles/{profile_id}/stop`
- `GET /api/profiles/{profile_id}/status`
- `GET /api/status`

Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:525`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:550`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:558`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:570`.

Clipboard:

- `POST /api/profiles/{profile_id}/clipboard`
- `GET /api/profiles/{profile_id}/clipboard`

Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:590`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:621`.

VNC and CDP:

- `WS /api/profiles/{profile_id}/vnc`
- `GET /api/profiles/{profile_id}/cdp`
- `GET /api/profiles/{profile_id}/cdp/json/version`
- `GET /api/profiles/{profile_id}/cdp/json/list`
- `WS /api/profiles/{profile_id}/cdp`
- `WS /api/profiles/{profile_id}/cdp/devtools/{path}`

Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:677`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:845`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:858`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:883`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:974`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:1002`.

## Auth and security behavior

`AUTH_TOKEN` is optional. If unset, routes are open. If set, raw ASGI middleware protects `/api/*` HTTP and websocket routes except `/api/auth/status`, `/api/auth/login`, and `/api/status`. It accepts either `Authorization: Bearer <token>` or an `auth_token` cookie. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:48`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:53`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:139`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:149`.

Login stores the raw token in an HTTP-only `SameSite=Strict` cookie. The cookie's `secure` attribute is set only when `X-Forwarded-Proto` indicates HTTPS. The README warns that the auth token is transmitted in cleartext over HTTP and recommends HTTPS reverse proxying for internet exposure. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:408`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:414`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:178`.

Websocket endpoints reject browser cross-origin requests when the `Origin` host does not match `Host`; no-Origin websocket clients are allowed for non-browser automation clients such as Playwright/Puppeteer. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:89`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:104`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:500`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:551`.

## VNC and clipboard internals

KasmVNC is run as `Xvnc` with `-websocketPort`, `-rfbport -1`, `-SecurityTypes None`, `-DisableBasicAuth`, `-interface 127.0.0.1`, and `-httpd /usr/share/kasmvnc/www`. That means raw VNC is disabled and KasmVNC is intended to be reached only through the backend proxy. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:53`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:56`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:60`.

The VNC proxy is not a blind websocket relay. It knows enough RFB to:

- Forward the first three handshake messages unchanged.
- Strip known unsupported noVNC/KasmVNC extension message types.
- Rewrite `SetEncodings` to only allowed encodings.
- Rewrite standard 6-byte pointer events into KasmVNC's 11-byte pointer event format.
- Convert KasmVNC BinaryClipboard server messages into standard RFB ServerCutText messages. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:188`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:230`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:296`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:317`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:333`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:739`.

Clipboard sync has three paths:

- Host to VNC: frontend intercepts Ctrl/Cmd+V, reads host `navigator.clipboard`, posts text to backend, backend writes it to the X clipboard with `xclip`, then frontend sends a full Ctrl+V sequence into noVNC.
- VNC to host through VNC protocol: frontend listens for noVNC `clipboard` events after the backend converts KasmVNC BinaryClipboard to ServerCutText.
- VNC to host through polling: because Chrome under KasmVNC may not write to X11 clipboard, backend reads injected `window.__clipboardText` from browser pages and the frontend polls every 2 seconds. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:83`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:590`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:136`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:621`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:163`.

## Build and deployment

Development commands in the README:

- Backend: create a Python venv, install `backend/requirements.txt`, run `uvicorn main:app --reload --port 8080`.
- Frontend: run `npm install` and `npm run dev`.
- Docker: run `docker compose up --build`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/README.md:76`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:87`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:95`.

The Dockerfile builds the React frontend in a `node:20-slim` stage, then uses `python:3.12-slim` for runtime. It installs Chromium system libraries, Playwright Chromium deps, Microsoft core fonts, KasmVNC 1.3.3, Python requirements, backend code, built frontend assets, pre-downloads the CloakBrowser binary with `ensure_binary()`, exposes `8080`, declares `/data`, and healthchecks `/api/status`. Sources: `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:1`, `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:12`, `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:25`, `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:35`, `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:44`, `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:54`, `/home/txchen/code/github/CloakBrowser-Manager/Dockerfile:57`.

Compose builds locally, publishes `127.0.0.1:8080:8080`, persists `~/.cloakbrowser-manager:/data`, and passes `AUTH_TOKEN` with an empty default. Source: `/home/txchen/code/github/CloakBrowser-Manager/docker-compose.yml:1`.

## Dependencies and licensing

Backend Python dependencies are FastAPI, Uvicorn, Pydantic, `cloakbrowser[geoip]`, `websockets`, and `httpx`. Frontend runtime dependencies are noVNC, lucide-react, React, and React DOM; dev dependencies include Vite, TypeScript, Tailwind, Vitest, Testing Library, PostCSS, and jsdom. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/requirements.txt:1`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/package.json:13`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/package.json:19`.

The GUI source is MIT licensed, but the compiled CloakBrowser binary is governed by a separate binary license. The README says the GUI application requires the CloakBrowser Chromium binary and that the binary is automatically downloaded on first launch; the binary license contains restrictions on redistribution/repackaging and mentions OEM/SaaS licensing for bundling or serving third-party customers. Sources: `/home/txchen/code/github/CloakBrowser-Manager/README.md:180`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:185`, `/home/txchen/code/github/CloakBrowser-Manager/BINARY-LICENSE.md:7`, `/home/txchen/code/github/CloakBrowser-Manager/BINARY-LICENSE.md:19`, `/home/txchen/code/github/CloakBrowser-Manager/BINARY-LICENSE.md:31`.

## Test coverage as executable documentation

Backend tests cover profile CRUD, launch/stop response behavior, status response shape, CDP URL rewriting, websocket origin validation, auth behavior, database CRUD/migrations, VNC allocation, proxy parsing, fingerprint args, CDP port allocation, first-launch profile defaults, and RFB parser/filter behavior. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:15`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:369`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_auth.py:1`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_database.py:1`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_vnc_manager.py:1`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_browser_manager.py:1`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_rfb.py:1`.

Frontend tests cover the API wrapper and `useProfiles` hook behavior, including fetch calls, mutation wrappers, and error handling. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/lib/api.test.ts:1`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/hooks/useProfiles.test.ts:1`.

Important gap: normal tests do not appear to launch real CloakBrowser/KasmVNC and drive the full viewer/CDP path end to end. The browser launch path is mostly validated through unit tests and mocks. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:141`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:264`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_browser_manager.py:91`.

## Notable risks and design constraints

1. Network exposure is easy to get wrong. The README quick-start `docker run -p 8080:8080` may expose the service more broadly than Compose, which binds `127.0.0.1:8080:8080`; inside the container Uvicorn binds `0.0.0.0`. If `AUTH_TOKEN` is unset, API routes are open. Sources: `/home/txchen/code/github/CloakBrowser-Manager/README.md:28`, `/home/txchen/code/github/CloakBrowser-Manager/docker-compose.yml:4`, `/home/txchen/code/github/CloakBrowser-Manager/entrypoint.sh:21`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:149`.
2. Auth is single-token, not user/session based. The cookie stores the same raw token, and the README warns HTTP transmits it in cleartext. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:408`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:156`, `/home/txchen/code/github/CloakBrowser-Manager/README.md:178`.
3. CDP is full browser control. It is exposed through the same optional auth layer, and no-Origin websocket clients are allowed intentionally for automation. Exposure without auth is high risk. Sources: `/home/txchen/code/github/CloakBrowser-Manager/README.md:119`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:89`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:974`.
4. User-supplied `launch_args` are appended directly to browser args. This is flexible but unsafe for untrusted users because flags can load extensions or change browser security/runtime behavior. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileForm.tsx:534`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:204`.
5. VNC compatibility depends on specific noVNC/KasmVNC protocol behavior. The custom RFB filtering/rewrite layer is necessary but fragile across upgrades. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:230`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:333`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_rfb.py:267`.
6. Clipboard sync can expose secrets. The frontend logs clipboard substrings in several paths, and backend xclip processes are kept alive per display to serve paste requests. Sources: `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:108`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:143`, `/home/txchen/code/github/CloakBrowser-Manager/frontend/src/components/ProfileViewer.tsx:171`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:586`.
7. Deleting a profile deletes the DB row first, then calls `shutil.rmtree(..., ignore_errors=True)` on the user data directory. A filesystem deletion failure can leave orphaned browser data hidden from the UI. Source: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:512`.
8. CDP capacity is capped by the fixed 100-port range `5100-5199`; if all ports are unavailable, launch fails. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:145`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:364`.
9. Profile metadata, proxies, notes, and other sensitive fields are stored plaintext in SQLite under `/data`. Source: `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:34`.
10. Startup cleanup uses broad `pkill` patterns. This is acceptable in a single-purpose container, but risky in a shared process namespace. Sources: `/home/txchen/code/github/CloakBrowser-Manager/entrypoint.sh:7`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:119`.

## Design ideas worth reusing

1. Split a browser profile into durable metadata plus a persistent browser user data directory, and keep live process/display/port state in a runtime registry. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/database.py:87`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:149`.
2. Bind internal browser-facing ports to loopback and expose only app-level proxied endpoints for UI, VNC, and CDP. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:56`, `/home/txchen/code/github/CloakBrowser-Manager/backend/vnc_manager.py:62`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:696`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:858`.
3. Rewrite CDP discovery URLs through the manager so Playwright/Puppeteer connect to stable external manager URLs rather than internal Chrome ports. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:876`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:393`.
4. Protect async launches with both a lock and an explicit `_launching` set, so duplicate launch requests during slow startup fail deterministically. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:160`, `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:171`.
5. Make `auto_launch` profile metadata, but run it asynchronously after startup so the service can become available while browsers launch. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:342`, `/home/txchen/code/github/CloakBrowser-Manager/backend/main.py:377`.
6. Treat first-launch profile defaults as product affordances. Bookmarks for diagnostic sites and a default privacy-oriented search provider make fresh profiles immediately useful. Source: `/home/txchen/code/github/CloakBrowser-Manager/backend/browser_manager.py:56`.
7. Put protocol shims under direct tests. This repo's tests around RFB parsing/filtering, VNC allocation, CDP URL rewriting, and websocket origin validation are especially valuable because those are brittle boundaries. Sources: `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_rfb.py:267`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_vnc_manager.py:18`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:393`, `/home/txchen/code/github/CloakBrowser-Manager/backend/tests/test_api.py:500`.

## Implications for building CloakHub

If CloakHub is meant to be similar but stronger, the core shape to preserve is:

- Durable profiles plus isolated browser user-data dirs.
- A launch manager that owns allocation, process lifecycle, cleanup, and status.
- A single external API/UI surface that proxies internal VNC and CDP.
- Explicit tests around protocol translation and URL rewriting.

Areas to improve early:

- Replace optional single-token auth with a real auth/session/permission model before supporting remote or multi-user use.
- Treat CDP and custom launch args as privileged capabilities.
- Avoid logging clipboard contents and consider making clipboard sync explicit per session.
- Use structured migrations instead of ad hoc `ALTER TABLE` checks once schema evolution matters.
- Add an end-to-end launch/view/CDP integration test path, because the highest-risk behavior crosses Python, Xvnc, CloakBrowser, noVNC, and browser CDP.
- Revisit deletion semantics so profile metadata and user-data removal cannot silently diverge.
