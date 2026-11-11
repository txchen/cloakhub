# Browser version evaluation

Run: 2026-11-10T20-59-44-285Z-58b5d0f1
Environment: Windows font isolation: only; replicate 2; identical evaluation image, 4 CPU/4GiB/2GiB shm, no GPU

Recorded 2/2; infrastructure errors 0; detector gaps 0.

**This is an observation report, not a universal stealth score.** CPU is whole-cgroup time; use only matched workloads and check frame counts. Font provenance is in manifest.json. A reference browser in Docker/CDP is not a real-human or native-Mac baseline.

| Plan / binary / persona / mode / variant | Completed | WebGL/2 | FP VM + / valid | FP tampering + / valid | IPHey completed | Median animation CPU seconds |
|---|---:|---:|---:|---:|---:|---:|
| detectors / only / windows / headed / configured | 1/1 | 1/1 | 0/1 | 1/1 | — | — |
| detectors / only / windows / headless / configured | 1/1 | 1/1 | 0/1 | 1/1 | — | — |

## Binary and font provenance

- only: 156.0.8078.47.1 (cloakbrowser), SHA-256 37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a.
- windows: /opt/evaluation/windows-fonts/configs/windows-only.conf, 14 font-family entries. Only the same 34 font files, excluding Linux/Mac families; NOT a complete Windows 10/11 inventory

## Detector details (positive or missing is not an execution failure)

| Group | FP bot not detected | FP anti-detect positive | SannySoft failure/warning observations | BrowserScan Normal | IPHey verdicts / scores |
|---|---:|---:|---:|---:|---|
| detectors / only / windows / headed / configured | 1/1 | 1/1 | — | — | [] / [] |
| detectors / only / windows / headless / configured | 1/1 | 1/1 | — | — | [] / [] |

## Local rendering and workload checks

| Group | GL create/draw/readback success | Routed requests | Context mismatches | Animation frames |
|---|---:|---:|---:|---|
| detectors / only / windows / headed / configured | 2/2 | — | 1 | [] |
| detectors / only / windows / headless / configured | 2/2 | — | 1 | [] |

## Feature and consistency observations

- detectors / only / windows / headed / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=1. Geometry is retained per case.
- detectors / only / windows / headless / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=1. Geometry is retained per case.

## Coverage gaps

Proxy DNS/WebRTC UDP, actual audio hardware, native OS realism, license fault injection and per-CVE security review require separately provisioned labs; they are not certified by this suite.

