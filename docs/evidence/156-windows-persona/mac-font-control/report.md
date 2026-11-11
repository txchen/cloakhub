# Browser version evaluation

Run: 2026-11-10T20-04-08-903Z-fc0486b7
Environment: cloakhub_free:0.8.4 pinned Linux x64 lab; 4 CPU, 4 GiB RAM, 2 GiB shm; no host GPU

Recorded 2/2; infrastructure errors 0; detector gaps 0.

**This is an observation report, not a universal stealth score.** CPU is whole-cgroup time; use only matched workloads and check frame counts. Font provenance is in manifest.json. A reference browser in Docker/CDP is not a real-human or native-Mac baseline.

| Plan / binary / persona / mode / variant | Completed | WebGL/2 | FP VM + / valid | FP tampering + / valid | IPHey completed | Median animation CPU seconds |
|---|---:|---:|---:|---:|---:|---:|
| detectors / candidate / windows / headed / configured | 1/1 | 1/1 | 0/1 | 1/1 | — | — |
| detectors / candidate / windows / headless / configured | 1/1 | 1/1 | 0/1 | 1/1 | — | — |

## Feature and consistency observations

- detectors / candidate / windows / headed / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=1. Geometry is retained per case.
- detectors / candidate / windows / headless / configured: popup opened=[], GPU vendors=["Google Inc. (Intel)"], touch points=[0], context mismatches=1. Geometry is retained per case.

## Coverage gaps

Proxy DNS/WebRTC UDP, actual audio hardware, native OS realism, license fault injection and per-CVE security review require separately provisioned labs; they are not certified by this suite.

