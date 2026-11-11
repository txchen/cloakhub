# Browser version evaluation

Run: 2026-11-10T20-16-37-714Z-931c2228
Environment: cloakhub_free:0.8.4 pinned Linux x64 lab; 4 CPU, 4 GiB RAM, 2 GiB shm; no host GPU

Recorded 1/1; infrastructure errors 0; detector gaps 0.

**This is an observation report, not a universal stealth score.** CPU is whole-cgroup time; use only matched workloads and check frame counts. Font provenance is in manifest.json. A reference browser in Docker/CDP is not a real-human or native-Mac baseline.

| Plan / binary / persona / mode / variant | Completed | WebGL/2 | FP VM + / valid | FP tampering + / valid | IPHey completed | Median animation CPU seconds |
|---|---:|---:|---:|---:|---:|---:|
| detectors / candidate / macos / headed / configured | 1/1 | 1/1 | 0/1 | 0/1 | 1/1 | — |

## Binary and font provenance

- candidate: 156.0.8078.47.1 (cloakbrowser), SHA-256 37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a.
- macos: /app/macos-fonts.conf, 63 font-family entries. Image bundles Mac fonts; explicit Mac fontconfig enabled

## Detector details (positive or missing is not an execution failure)

| Group | FP bot not detected | FP anti-detect positive | SannySoft failure observations | BrowserScan Normal | IPHey verdicts / scores |
|---|---:|---:|---:|---:|---|
| detectors / candidate / macos / headed / configured | 1/1 | 0/1 | 0/1 | 1/1 | ["Trustworthy"] / [100] |

## Local rendering and workload checks

| Group | GL create/draw/readback success | Routed requests | Context mismatches | Animation frames |
|---|---:|---:|---:|---|
| detectors / candidate / macos / headed / configured | 2/2 | — | 1 | [] |

## Feature and consistency observations

- detectors / candidate / macos / headed / configured: popup opened=[], GPU vendors=["Google Inc. (Apple)"], touch points=[0], context mismatches=1. Geometry is retained per case.

## Coverage gaps

Proxy DNS/WebRTC UDP, actual audio hardware, native OS realism, license fault injection and per-CVE security review require separately provisioned labs; they are not certified by this suite.

