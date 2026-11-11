# Development

Development workflow skills are installed globally rather than vendored in this repository.

The Hub is a Go program (`cmd/cloakhub`, packages under `internal/`). The operator UI is
TypeScript in `src/ui/`, bundled by esbuild into `internal/web/dist/` and embedded in the
binary. Bun and Node are only development tools: they run the UI type check, the browser
skill and its tests, and Playwright.

| Package | Responsibility |
| --- | --- |
| `internal/config` | Environment configuration |
| `internal/profile` | Profile fields, validation, redaction, SQLite repository and service |
| `internal/events` | Bounded lifecycle event log |
| `internal/procs` | Owned Processes: pid files, ownership markers, cleanup, resource usage |
| `internal/browser` | Browser Instance runtime: launch, capacity, idle sleep, crash handling, proxy relay, Xvfb/voxl display, clipboard |
| `internal/cdp` | CDP gateway, discovery rewriting, WebSocket relay and last-tab protection |
| `internal/viewer` | Hub-wide viewer stream settings |
| `internal/web` | HTTP routes, auth, presentation, server-rendered pages, viewer proxy, embedded UI |

## Run

Requires Go (see `go.mod`) and Bun for the UI bundle.

```sh
bun install
bun run start        # builds the UI bundle, then go run ./cmd/cloakhub
```

Startup requires a discoverable CloakBrowser Binary (see the
[pinned deployment build](../README.md#docker)). Set `CLOAKHUB_BROWSER_BIN`, provide
the packaged Docker path, or install `cloakbrowser` on `PATH`. CloakHub assumes the
binary is unrestricted: it neither downloads browsers nor manages license keys.
Headed Browser Profiles also require `Xvfb` and [voxl](https://github.com/tembo/voxl) (`cargo install voxl-server`; override paths with `CLOAKHUB_XVFB_BIN` / `CLOAKHUB_VOXL_BIN`); if either is missing, startup continues with a warning and headed launch/viewer actions fail until both are installed. The viewer needs a secure page: open `http://localhost:7788` or an HTTPS origin.

During UI work, `CLOAKHUB_UI_DIST=internal/web/dist` serves bundles from disk, so
`./scripts/build-ui.sh` takes effect without rebuilding the binary.

## Tests

Unit tests do not launch real CloakBrowser, Xvfb, or voxl:

```sh
go test ./...          # Hub (add -race where cgo is available)
bun test               # browser skill, browser evaluation and packaging checks
bunx tsc --noEmit      # UI and test type checks
```

Real-runtime integration tests (`internal/integration`) are opt-in. They run inside a
CloakHub image, which provides CloakBrowser, Xvfb and voxl:

```sh
docker build -t cloakhub:local .
./scripts/real-runtime-tests.sh cloakhub:local
```

They exercise real headless and headed launch, WebGL and WebGL2 pixels on the default
headed profile, regional settings, protected connection metadata and CDP Transparent
Recovery, the voxl viewer stream through the Hub, spin-down/recovery persistence, and
explicit Stop overriding active clients. They do not depend on public bot-detection
websites.

The CDP relay has opt-in tests with real Playwright clients and a local Chromium. They
run the relay through `internal/cdp/relayfixture`, so Go must be installed:

```sh
CLOAKHUB_RUN_CDP_TESTS=true bun test tests/cdp-browser.integration.test.ts tests/browser-skill.integration.test.js
```

They verify last-tab protection under concurrent closes, profile-token authentication,
tab reuse across skill script rounds, and disconnect without browser shutdown. They use
Playwright's installed Chromium, or `CLOAKHUB_TEST_BROWSER` when specified.

## Browser version evaluation

Use the [reusable browser evaluation suite](browser-evaluation.md) when comparing a
new CloakBrowser binary with the deployed baseline. It has config-driven paired
persona/seed/mode matrices, local Canvas/Worker/iframe/WebGL and request-interception
probes, CPU measurements, graphics-flag isolation, and opt-in public detector adapters.
Exact binary versions, hashes, argv and per-persona font provenance are recorded.

```sh
npm run test:browser-evaluation:unit
npm run test:browser-evaluation -- --config tests/browser-evaluation/example.config.json --plan all --dry-run
```

The example uses container paths; follow the guide for the pinned Docker lab.
Real execution needs explicit binaries and (where required) a license file.
`--plan detectors` requires `--external`; ordinary `bun test` never launches this
matrix or visits public detector sites. Measurement completion is not a stealth pass.

## Frontend development and verification

HTTP routing lives in `internal/web/app.go` and `routes.go`, response presentation in
`internal/web/presentation.go`, the server-rendered shell in `internal/web/pages.go`, and
browser code and CSS in `src/ui/`. The JSON shapes the UI consumes are typed in
`src/ui/types.ts`.

```sh
bunx tsc --noEmit
bunx playwright install chromium
bun run test:ui
```

The UI suite runs the real HTTP app (`internal/web/uifixture`) over an isolated SQLite
data directory with controlled runtime handles. Set `CLOAKHUB_TEST_BROWSER=/path/to/chrome`
to use an installed browser. It covers create/edit errors, proxy preservation and
removal, lifecycle confirmations, token-copy fallback, sidebar switching, viewer
continuity while editing, external profile changes, and narrow screens. Real browser
persistence and runtime settings remain covered by the real-runtime integration tests.

## Publishing images

To release, update `package.json`, commit and push the changes, and wait for the
Tests workflow to pass. Push a matching Git tag (for example `v1.1.0`) to run the
Release workflow, which builds and smoke-tests both architectures before publishing.
