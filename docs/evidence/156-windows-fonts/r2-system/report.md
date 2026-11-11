# Browser version evaluation

Run: 2026-11-10T21-03-17-639Z-bda0997c
Environment: Windows font isolation: system; replicate 2; identical evaluation image, 4 CPU/4GiB/2GiB shm, no GPU

Recorded 2/2; infrastructure errors 0; detector gaps 0.

**This is an observation report, not a universal stealth score.** CPU is whole-cgroup time; use only matched workloads and check frame counts. Font provenance is in manifest.json. A reference browser in Docker/CDP is not a real-human or native-Mac baseline.

| Plan / binary / persona / mode / variant | Completed | WebGL/2 | FP VM + / valid | FP tampering + / valid | IPHey completed | Median animation CPU seconds |
|---|---:|---:|---:|---:|---:|---:|
| detectors / system / windows / headed / configured | 1/1 | 1/1 | 0/1 | 1/1 | — | — |
| detectors / system / windows / headless / configured | 1/1 | 1/1 | 0/1 | 1/1 | — | — |

## Binary and font provenance

- system: 156.0.8078.47.1 (cloakbrowser), SHA-256 37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a.
- windows: system fontconfig, 29 font-family entries. Unchanged system fontconfig; added files are outside its search path

## Detector details (positive or missing is not an execution failure)

| Group | FP bot not detected | FP anti-detect positive | SannySoft failure/warning observations | BrowserScan Normal | IPHey verdicts / scores |
|---|---:|---:|---:|---:|---|
| detectors / system / windows / headed / configured | 1/1 | 1/1 | — | — | [] / [] |
| detectors / system / windows / headless / configured | 1/1 | 1/1 | — | — | [] / [] |

## Local rendering and workload checks

| Group | GL create/draw/readback success | Routed requests | Context mismatches | Animation frames |
|---|---:|---:|---:|---|
| detectors / system / windows / headed / configured | 2/2 | — | 1 | [] |
| detectors / system / windows / headless / configured | 2/2 | — | 1 | [] |

## Feature and consistency observations

- detectors / system / windows / headed / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=1. Geometry is retained per case.
- detectors / system / windows / headless / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=1. Geometry is retained per case.

## Coverage gaps

Proxy DNS/WebRTC UDP, actual audio hardware, native OS realism, license fault injection and per-CVE security review require separately provisioned labs; they are not certified by this suite.

