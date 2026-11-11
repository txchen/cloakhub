# 152 → 156 follow-up evidence

Interpretation: [report](../../152-vs-156-followup.md). This extends, rather than replaces, the earlier detector matrix.

## Records and modes

- `results.json`: formal profiles only; smoke round 0 is excluded. Canvas raw bytes and PNGs are reduced to hashes and differing-byte counts. Fingerprint retains an allowlist of verdicts, not visitor/event IDs, IP addresses or full response bodies.
- `summary.json`: computed container CPU and workload counts.
- `environment.json`: image digest, reference-browser download/version/hash and runtime/resource settings.
- `followup.mjs`, `surface.mjs`: harness and page/worker probe.
- `verify.mjs`: saved-evidence assertions, not a new browser run.

Round map:

| Round | Scope |
|---|---|
| 1, 2 | 24 profiles: 152/156 × headed/headless × three seeds × two reversed-order rounds; local surfaces, 200 routed requests/profile, idle and animation CPU |
| 3 | 6 profiles: popup flag off/on, both CloakBrowser builds and stock Chrome |
| 4 | 6 profiles: deliberately out-of-bounds requested window position, three builds × two modes |
| 5 | 2 profiles: stock Chrome default-graphics Fingerprint reference |
| 6 | 4 profiles: 152/156 × Linux/macOS persona, headed Fingerprint control |
| 7 | 4 profiles: Windows persona, vendor abbreviation and touch-point override |
| 8 | 6 profiles: `--start-maximized`, three builds × two modes |
| 9 | 2 profiles: stock Chrome with explicit software-renderer fallback, Fingerprint reference |

Total: 54 formal profiles. Only rounds 5/6/9 visit the external detector (8 visits); the rest use local fixtures. Single-case feature/reference groups are not six independent observations each.

The default stock-Chrome reference had no WebGL context. Its separate software-renderer arm adds `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` in an attempt to enable a software context. That attempt also returned null WebGL contexts with Vulkan/EGL initialization errors; it did not produce a working-graphics stock baseline. This is a **different, labeled control**, not a claim that all three browsers ran identical graphics flags or that this flag set should be deployed. No authenticated business browsing is performed.

## Reproduce

Requirements: Linux x64, Docker, authorized 156 binary/resources and a valid key file. All runs are serial; do not occupy the same free license concurrently. No production profiles, ports, GPU devices or service configuration are mounted.

Create fresh private runtime/work directories. Do not reuse an existing result directory: deterministic sample IDs will overwrite files.

```bash
RUNTIME="$PWD/.scratch/cloak-followup-runtime"
WORK="$PWD/.scratch/cloak-followup-reproduction"
mkdir -p "$RUNTIME" "$WORK"
chmod 700 "$RUNTIME" "$WORK"
printf '*\n' > "$RUNTIME/.gitignore"
printf '*\n' > "$WORK/.gitignore"
npm install --prefix "$RUNTIME" playwright-core@1.64.1 --ignore-scripts --no-audit --no-fund
npm install --prefix "$WORK" pngjs@7.0.0 --ignore-scripts --no-audit --no-fund
cp docs/evidence/152-vs-156-followup/{followup,surface}.mjs "$WORK/"

NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
BASE=ghcr.io/txchen/cloakhub_free:0.8.4@sha256:961f1ac4b12c2c15569e7765bc09cbb0ebdad77892f52496b025c67b121bec33
docker pull "$NODE_IMAGE"
C=$(docker create "$NODE_IMAGE")
docker cp "$C:/usr/local/bin/node" "$RUNTIME/node"
docker rm "$C"

# Pinned Playwright package installs Chrome for Testing 156.0.8078.4 / revision 1248.
docker run --rm --security-opt label=disable \
  -v "$RUNTIME:/runtime:ro" -v "$WORK:/work" \
  -e PLAYWRIGHT_BROWSERS_PATH=/work/reference-browser \
  --entrypoint /runtime/node "$BASE" \
  /runtime/node_modules/playwright-core/cli.js install chromium --no-shell
```

Run `smoke` first, inspect errors, then run `surfaces`, `extras`, `sites` **sequentially**. `sites` has a 45-second cooldown between profiles; do not evade any rate limit. Its stock Chrome is a CDP-driven virtual-display reference, not a real-user control.

```bash
MODE=surfaces
BINARY156="$HOME/.cloakbrowser/chromium-156.0.8078.47.1-pro"
KEY_FILE="$HOME/.cloakbrowser/license.key"
docker run --rm --cpus 4 --memory 4g --shm-size 2g \
  --security-opt label=disable \
  -v "$RUNTIME:/runtime:ro" -v "$WORK:/work" \
  -v "$BINARY156:/opt/browser156:ro" -v "$KEY_FILE:/run/key:ro" \
  --entrypoint /runtime/node "$BASE" /work/followup.mjs "$MODE"
```

Keys are read from a mounted file and placed only in the browser environment, not argv. SELinux label isolation is disabled only for these explicit task-container mounts. CPU data is cgroup-wide: browser, GPU/renderer, Xvnc, Node and fixture server combined. A 5-second observation can use up to about 20 CPU seconds at four cores. Animated frames are JS rAF draw counts, not externally measured presented frames.

A plain Xvnc display lacks a desktop window manager; use the stored CDP window state to qualify any `--start-maximized` interpretation. `document.fonts.check` can report true for nonexistent families, so `checkTrue` is not an installed-font count. Cross-origin iframe here means a different local port, not a separate registrable site. Dedicated Worker coverage does not imply SharedWorker/ServiceWorker coverage.

The harness performs its local main/worker/frame probes before the external detector in each reference profile. This differs from opening a detector as the first ever page; interpret reference signals with that context. Reference profiles are all fresh, but the detector can associate visits server-side. Actual external IPs are not retained; there is no claim of experimentally proving fixed IP identity across every observation.

`surface.mjs` intentionally measures page-world properties. A popup attempt comes from a timer in the served HTML, **not** a Playwright evaluate call with possible user-gesture semantics. PNG pixel comparison uses Node `pngjs@7.0.0` outside the browser, avoiding a second Canvas readback transformation. Request interception uses Playwright `route.fetch`, so the workload is a stability fixture and not proof of browser proxy routing.

Validate saved results:

```bash
node docs/evidence/152-vs-156-followup/verify.mjs
```
