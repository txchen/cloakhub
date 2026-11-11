# Browser version evaluation

Run: 2026-11-10T21-12-34-719Z-53820b5b
Environment: Windows font isolation: strong generic defaults; two rounds; same image and limits as original 12 observations

Recorded 4/4; infrastructure errors 0; detector gaps 0.

**This is an observation report, not a universal stealth score.** CPU is whole-cgroup time; use only matched workloads and check frame counts. Font provenance is in manifest.json. A reference browser in Docker/CDP is not a real-human or native-Mac baseline.

| Plan / binary / persona / mode / variant | Completed | WebGL/2 | FP VM + / valid | FP tampering + / valid | IPHey completed | Median animation CPU seconds |
|---|---:|---:|---:|---:|---:|---:|
| detectors / defaults / windows / headed / configured | 2/2 | 2/2 | 0/2 | 2/2 | — | — |
| detectors / defaults / windows / headless / configured | 2/2 | 2/2 | 0/2 | 2/2 | — | — |

## Binary and font provenance

- defaults: 156.0.8078.47.1 (cloakbrowser), SHA-256 37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a.
- windows: /opt/evaluation/windows-fonts/configs/windows-defaults.conf, 14 font-family entries. Same 34 font files and system rendering rules; strong generic aliases map sans-serif/serif/monospace to Arial/Times New Roman/Courier New; modern Windows families remain missing

## Detector details (positive or missing is not an execution failure)

| Group | FP bot not detected | FP anti-detect positive | SannySoft failure/warning observations | BrowserScan Normal | IPHey verdicts / scores |
|---|---:|---:|---:|---:|---|
| detectors / defaults / windows / headed / configured | 2/2 | 2/2 | — | — | [] / [] |
| detectors / defaults / windows / headless / configured | 2/2 | 2/2 | — | — | [] / [] |

## Local rendering and workload checks

| Group | GL create/draw/readback success | Routed requests | Context mismatches | Animation frames |
|---|---:|---:|---:|---|
| detectors / defaults / windows / headed / configured | 4/4 | — | 2 | [] |
| detectors / defaults / windows / headless / configured | 4/4 | — | 2 | [] |

## Feature and consistency observations

- detectors / defaults / windows / headed / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=2. Geometry is retained per case.
- detectors / defaults / windows / headless / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=2. Geometry is retained per case.

## Coverage gaps

Proxy DNS/WebRTC UDP, actual audio hardware, native OS realism, license fault injection and per-CVE security review require separately provisioned labs; they are not certified by this suite.

