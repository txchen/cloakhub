# Ordinary disk cache budget

CloakHub 0.6.1 defaults to 256 MiB of HTTP disk cache per profile, configurable with
`CLOAKHUB_DISK_CACHE_SIZE_MB` (integer 1–2047). The launcher converts MiB to bytes for
Chromium's `--disk-cache-size`; custom profile arguments cannot override the owned flag.
Existing profiles receive the setting on their next browser launch.

## Real browser verification

Linux amd64, CloakBrowser 151.0.7922.108.4 (CDP: Chrome/151.0.7922.108), headless.
Used the published 0.6.0 image with the modified source mounted read-only, an isolated
profile, and the previously verified browser binary. One real license was used and the
browser was closed through CDP after the test. Existing deployment data was not modified.

To exercise eviction quickly, set the launcher budget to 8 MiB. An HTTP fixture served
200 distinct resources of 256 KiB each, with `Cache-Control: public, max-age=86400`.
Access used direct CDP without disabling the HTTP cache.

| Observation | Result |
| --- | --- |
| Total resource content fetched | 50 MiB |
| Whole profile after first 25 MiB batch (`du -sk`) | 9,512 KiB |
| Whole profile after second batch (`du -sk`) | 10,012 KiB |
| Ordinary cache after browser exit (`Default/Cache`) | 7,820 KiB, about 7.64 MiB |
| Oldest resource fetched again | New HTTP request: old entry evicted |
| Most recent resource fetched again | No new HTTP request: entry retained |
| Cookie and localStorage sentinels | Preserved |

The configured budget therefore triggered eviction in this 151 build. This short test
is not a proof of an exact filesystem ceiling or long-term behavior for all workloads.
Cache metadata and in-flight writes can exceed the target. IndexedDB, Service Worker
Cache Storage, cookies, downloads, and other profile data are outside this budget.
Lowering the budget does not synchronously prune an existing oversized cache.

Local reproduction script and logs are under ignored `.cloakhub/cache-budget/`.
