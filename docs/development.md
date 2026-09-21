# Development

Development workflow skills are installed globally rather than vendored in this repository.

## Run

```sh
bun install
bun run start
```

For local development, startup requires a discoverable CloakBrowser Binary (see the
[pinned deployment build](../README.md#docker)). Set `CLOAKHUB_BROWSER_BIN`, provide
the packaged Docker path, or install `cloakbrowser` on `PATH`.
Headed Browser Profiles also require KasmVNC `Xvnc`; if it is missing, startup continues with a warning and headed launch/viewer actions fail until `Xvnc` is installed.

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

The browser skill has an additional opt-in client test using local Chromium through
the CDP proxy. It verifies profile-token authentication, tab reuse across script
rounds, and disconnect without browser shutdown:

```sh
CLOAKHUB_RUN_CDP_TESTS=true bun test tests/browser-skill.integration.test.js
```

It uses Playwright's installed Chromium, or `CLOAKHUB_TEST_BROWSER` when specified;
it does not require a deployed hub or a CloakBrowser license.

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

## Publishing images

To release, update `package.json`, commit and push the changes, and wait for the
Tests workflow to pass. Push a matching Git tag (for example `v0.7.0`) to build
the release images. The image workflow checks that the tag matches the package
version before publishing.
