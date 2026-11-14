# Background tab execution and focus emulation

Evaluated 2026-11-13 on Linux x64. This experiment changes no production browser or skill defaults.

## Recommendation

Keep `connectOverCDP({ noDefaults: true })` as the shared-profile default. On **released CloakBrowser 156.0.8078.47.1 with pinned Playwright 1.63.0**, explicitly enabling task-page focus emulation fixes background clicks, whereas background-throttling flags do not. The same pattern appears in stock Chromium. Current-release validation also covered two CDP clients, focus-session cleanup, native X keyboard input and the actual Hub/voxl viewer. This supports a scoped opt-in capability, not switching every client to `noDefaults: false`.

`noDefaults: false` changes more than focus: Playwright also applies download and media defaults. Focus emulation changes page visibility/focus reporting. Cleanup restored hidden visibility and preserved foreground keyboard delivery, but `document.hasFocus()` remained true after task DOM interaction. Full restoration to the initial focus state is therefore **not** claimed. No production defaults or opt-in API were introduced by this experiment.

## Reproduce without a live profile

The runner is [scripts/evaluate-background-tabs.mjs](../scripts/evaluate-background-tabs.mjs). It creates a new temporary browser profile for each matrix cell, chooses a private ephemeral CDP port, connects only to loopback and deletes its profile after closing the owned process group. It never loads CloakHub client configuration, a personal profile, or credentials. All pages are local `data:` fixtures; no website or model service is involved. SIGINT/SIGTERM stops the matrix, cleans the owned group/profile, writes an `incomplete` report with `interruptedBy`, and exits 130/143. An actual SIGTERM run verified exit 143, an incomplete report and no remaining temporary profiles.

Run on a **private test display**, not the user's desktop:

```sh
DISPLAY=:99 node scripts/evaluate-background-tabs.mjs \
  --browser stock=/absolute/path/to/chrome \
  --browser cloak=/absolute/path/to/cloakbrowser/chrome \
  --repeat 2 --output /tmp/background-tabs.json
```

Each browser installation must include its matching resources. Dereference absolute resource symlinks before moving an installation into a container. The executable alone is insufficient.

The current-release matrix used a disposable container, no network/published ports, a private Xvfb display and read-only repo mount. Build a test-only derivative of the released runtime to add Node and the native-input probe:

```sh
docker build -t cloakhub-focus-evaluation:1.2.0 - <<'DOCKER'
FROM node:24-bookworm-slim AS node
FROM ghcr.io/txchen/cloakhub:1.2.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends xdotool \
    && rm -rf /var/lib/apt/lists/*
DOCKER
```

```sh
docker run --rm --init --network none --shm-size=1g --entrypoint sh \
  -v "$PWD:/work:ro" cloakhub-focus-evaluation:1.2.0 -c '
    Xvfb :99 -screen 0 1280x800x24 -dpi 96 -nolisten tcp \
      -ac -shmem -noreset -extension GLX \
      >/tmp/display.log 2>&1 &
    export DISPLAY=:99
    cd /work
    node scripts/evaluate-background-tabs.mjs \
      --browser cloak156=/opt/cloakbrowser/chrome --repeat 2
  ' > /tmp/background-tabs.json
```

The runner resolves `playwright-core` from the skill's package directory first. Install its pinned dependency with `npm ci --prefix skills/cloakhub-browser` before mounting the checkout read-only. If resolution falls back to the root dependency, the report records `dependencySource: "root-fallback"` and its actual version; that is not a pinned-skill validation. Replace `--repeat 2` with `--focus-lifecycle-only` for the two-client/native-X/cleanup probe; this mode requires xdotool and skips the ordinary matrix.

## Matrix and measured effects

Each browser/flag/mode combination gets two background and two foreground trials. The runner recreates the target document per trial, samples `requestAnimationFrame` progress over 400 ms, reads visibility/focus, fills an input and clicks Save with a 1.5-second action deadline. Success requires the actual page to contain the filled value and **exactly one** increment of the click counter. A returned click alone is not the score.

Modes:

- `noDefaults`: the skill's current connection option.
- `playwrightDefaults`: `noDefaults: false`.
- `noDefaults+focus`: preserves `noDefaults: true`, explicitly sends `Emulation.setFocusEmulationEnabled({ enabled: true })` for the task page, and keeps that CDP session attached.

Flag groups:

- `current`: the production launcher's rendering subset, `--disable-gpu --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader`.
- `unthrottled`: the same plus `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`.

Other arguments are recorded in the runner. This does **not** replicate every production fingerprint/persona option or the Hub proxy. `current` means the rendering subset only.

Completed **CloakBrowser 156** results (24 total trials; [full evidence](evidence/background-tabs/cloak156-results.json)):

| Rendering flags | Connection mode | Background confirmed | Foreground confirmed | Background frames in 400 ms, two trials | Background fill+click median |
| --- | --- | --- | --- | --- | --- |
| current | noDefaults | 0/2 | 2/2 | 0, 0 | 1567 ms (click timeout) |
| current | playwrightDefaults | 2/2 | 2/2 | 24, 24 | 98 ms |
| current | noDefaults+focus | 2/2 | 2/2 | 24, 25 | 104 ms |
| unthrottled | noDefaults | 0/2 | 2/2 | 0, 0 | 1554 ms (click timeout) |
| unthrottled | playwrightDefaults | 2/2 | 2/2 | 24, 24 | 94 ms |
| unthrottled | noDefaults+focus | 2/2 | 2/2 | 24, 24 | 100 ms |

All 24 fills succeeded. The four failed clicks left the click counter at zero; the 20 successful trials incremented it exactly once. Background `noDefaults` pages reported hidden/unfocused; both focus-enabled variants reported visible/focused even while the cover tab was in front. These timings illustrate the deadline effect, not a speed benchmark. An independently completed 24-trial stock Chromium/pinned-library control produced the same pass/fail pattern; its original evidence remains in [results.json](evidence/background-tabs/results.json).

## Two clients, cleanup and actual viewer input

[The native-input probe](evidence/background-tabs/cloak156-focus-lifecycle.json) connected two clients to one owned browser. Client A enabled focus emulation only on its background task tab; client B used the foreground user tab. Native X keyboard input reached B before and after A's successful background click. CDP-session detach, explicit `enabled:false`, and disconnect of the owning client each restored A's `visibilityState` to `hidden`.

[The real-viewer probe](evidence/background-tabs/cloak156-viewer.json) used a separate synthetic profile in the released Hub. Its normal macOS-persona browser ran under the Hub's own Xvfb/voxl. Two CDP clients shared that profile, while a stock Chromium browser opened `/ui/profiles/.../viewer`. The voxl video reached readyState 4, decoded a frame at 1366×768, and actual keyboard events sent through the viewer reached the foreground page:

| Point | Foreground input value | Background result |
| --- | --- | --- |
| Before agent action | `viewer-input` | pending |
| After background Save | `viewer-input-after-agent` | saved |
| After focus disable/detach | `viewer-input-after-agent-after-cleanup` | task hidden |

This validates actual video and keyboard transport, not merely simulated page state. Both tests observed `hasFocus() === true` on the hidden task page after cleanup; visibility restoration does not mean every focus observable returned to baseline. Neither test establishes isolation between arbitrary concurrent tasks.

Reproduce using [viewer-check.mjs](evidence/background-tabs/viewer-check.mjs) against a dedicated unauthenticated loopback Hub, with an explicit local viewer-browser executable:

```sh
node docs/evidence/background-tabs/viewer-check.mjs \
  http://127.0.0.1:PORT /absolute/path/to/chrome > /tmp/viewer-focus.json
```

The script creates and deletes its own timestamped synthetic profile, verifies deletion in the report, and never enumerates other profiles. The test Hub was bound only to host loopback with an ephemeral port and used no production data volume. Viewer browser version was 158.0.8127.18; the **remote tested browser** was CloakBrowser 156.0.8078.47.1.

## Environment and evidence boundaries

- All current scored matrices and viewer/lifecycle probes: Playwright 1.63.0 from the installed skill dependency (`dependencySource: "skill"` for the matrix).
- Current runtime: `ghcr.io/txchen/cloakhub:1.2.0`, release digest `sha256:40203496a404bd71a1416fb5a634d3976f48361274a0315c32a24617d4180dcf`. Test-only derivative adds Node 24.22.2 and xdotool; final local image digest `sha256:76627709454e651ab3f0d230ee7d8a7147ce7a466188107a9505c7f5788834b9`. Browser/resources/runtime defaults are unchanged. The matrix before xdotool was added used the same release plus Node only. Xvfb arguments match the production display runtime.
- Stock browser: Chromium 158.0.8127.18; executable SHA-256 `76bcde21a2f8c9d4fbbf42afbeab011817d000552d093e5f5e89c9b8808f4231`.
- Historical control image: `cloakhub-browser-evaluation:local`, image ID `sha256:a4f6749c8f172ea1c057e024e279e8b63b74dddd0103de64cf4faf2e69611366`; Debian 12, KasmVNC 1.3.3; no host GPU/display mounts.
- CloakBrowser executable SHA-256 is `ef78214b823c9a51b0e05d5761025478ad5206c40d0153a8926a2a4a4e0911be`. Earlier SIGTRAP startup failures in the historical image are preserved in [launch-diagnostics.json](evidence/background-tabs/launch-diagnostics.json). Switching to the complete released runtime resolved startup and enabled every current test above. The executable and main `.pak`, `.bin`, `.dat`, `.so` resource hashes match between the two installations; no particular library or path is identified as the crash root cause. These failures are now historical environment diagnostics, **not an outstanding current-browser validation gap**.
- An exploratory run of the image's older CloakBrowser 152 timed out loading the fixture and was stopped; no interaction scores are claimed for it.
- Two repeats reproduce a fixture symptom, not website-wide reliability. Native X and real viewer keyboard input were automated, not a human usability study. No authenticated site, Canvas, challenge, fingerprint detection, large-scale concurrency or general multi-client arbitration was evaluated.
- The script intentionally uses raw page evaluation to read the synthetic fixture's counters. This is instrumentation of a page we own, not a recommendation to change normal site-observation policy.

## Why this result is plausible

[Playwright's `noDefaults` contract](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) explicitly disables focus emulation on the existing default context. The locally inspected 1.64.1 implementation also conditionally skips `Emulation.setFocusEmulationEnabled` when this option is set, and the pinned 1.63.0 behavioral rerun agrees. [The ordinary Pages guide](https://playwright.dev/docs/pages#multiple-pages) says pages behave as focused/active without `bringToFront`; that statement must be interpreted alongside the `noDefaults` exception and the connection mode.

[Actionability documentation](https://playwright.dev/docs/actionability) distinguishes clicks, which wait for stability, from fill, which does not. In the failing fixture, a hidden page stops advancing animation frames, fill succeeds, and click times out. Explicit focus emulation restores both visible/focused reporting and click execution. This supports a specific explanation for this fixture rather than a claim that every timeout is caused by focus.

## Next implementation gate

The release-browser, pinned-library, two-client, viewer-input and disconnect checks above are complete. A future opt-in should be page-scoped, preserve `noDefaults:true`, explicitly disable emulation in `finally` and detach its CDP session. Its contract must describe the observed remaining `hasFocus()` behavior and must not promise task isolation. Before making it a default, separately assess focus-dependent/lazy real sites and fingerprint effects. Keep `bringToFront()` available; do not add global unthrottling flags based on this experiment.
