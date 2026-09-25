# Mac persona: 152 preview vs 151 stable comparison

Test date: 2026-09-11 (America/Los_Angeles; raw logs are UTC 2026-09-12).

The standard build has moved to preview `152.0.7977.82.1`. In this comparison, all three of 152's Fingerprint tampering-model scores were lower than 151, and routine functional tests found no version regression. This is not an estimate of pass rates across all websites; the two builds already had the same boolean verdicts on the major detectors.

## Environment and installation

| Item | stable | preview |
| --- | --- | --- |
| Official full version | 151.0.7922.108.6 | 152.0.7977.82.1 |
| Version returned by CDP | 151.0.7922.108 | 152.0.7977.82 |
| Full Chrome version in web Client Hints | 151.0.7922.109 | 152.0.7977.83 |
| Logical browser directory size | 782,547,835 bytes | 787,839,336 bytes |

The official version endpoint was queried for Linux x64 and ARM64 separately; both returned the versions above, and preview did not fall back to stable. The live tests covered Linux amd64 only. Sources: [stable](https://cloakbrowser.dev/api/download/version), [preview](https://cloakbrowser.dev/api/download/version?channel=preview); requests used the `X-Platform` header.

Both groups used the same app image `sha256:ce9ef8ad88295249f120d82e7c3a7a479612222b90839a98335dc88e8acccd79`, changing only the browser version and channel. Both installed from an empty cache through the official `cloakbrowser@0.5.10` downloader, retaining Ed25519, manifest version, and SHA-256 verification; no explicit binary path was used to bypass managed installation. The actual download paths and CDP versions were checked.

Common conditions: Mac persona, 46 real font files (55.06 MiB), headed, 1366×768, DPR 1, 4-CPU quota, 2 GiB shared memory, SwiftShader software rendering, en-US, America/Los_Angeles, same egress. Public detection used no proxy, account, or custom UA. The three new profiles had seeds 20260909, 20260910, 20260911; each seed was the same for both builds. The second group swapped run order, and all browsers ran serially to fit a single-session license.

## Public detection

| Seed | 151 tampering_ml_score | 152 tampering_ml_score |
| --- | ---: | ---: |
| 20260909 | 0.2322 | 0.0967 |
| 20260910 | 0.0748 | 0.0300 |
| 20260911 | 0.1258 | 0.0541 |

All six Fingerprint observations were: `bot=not_detected`, `tampering=false`, `anomaly_score=0`, `anti_detect_browser=false`, `virtual_machine=false`. All six Device & Browser Info observations were `isBot=false`, with no true entries. The model score is not a business pass rate and should not be read as "the probability of being banned by a website." The score is affected by engine version, feature combination, and server-side model; this comparison cannot localize it to a specific patch.

The following sites were compared in full only for the first seed:

| Detection item | 151 | 152 |
| --- | --- | --- |
| Sannysoft | no failed rows in the table | same |
| Rebrowser | mainWorldExecution and exposeFunctionLeak red; the rest green | same |
| CreepJS | 31% like headless, 0% headless, 0% stealth | same |
| CreepJS font-loading probe | 2/51 | same |
| Iphey | 100, Trustworthy | same |

The Rebrowser script deliberately executes main-world code and calls `exposeFunction` as required by the site, so those two items can observe automation; these results cannot be described as "all anti-detection items green." CreepJS's 2/51 is its specific font-list probe result, not that only two fonts are installed locally. All 20 public-site visits returned HTTP 200, with no page navigation errors recorded.

## Functionality and fingerprint consistency

Routine tests: 211 passed; typecheck passed. The 10 real-browser integration tests skipped by default were explicitly enabled and run on both builds, each with 10 passed and 0 failed. These ten cover WebGL pixels, regional/dark settings, headless/headed, KasmVNC/RFB, CDP auth, auto-wake, persistence after idle sleep, forced stop, and multi-client tab close. Their fixture uses the app's base Linux defaults; Mac defaults are tested separately through the live Docker service below.

Both builds passed:

- UI/API default create a Mac profile; an explicit Linux profile keeps a Linux identity and cannot load private Helvetica Neue.
- Mac multilingual input, iframes, popups, upload, download, multiple CDP clients.
- Wake after browser stop preserves cookies, localStorage, IndexedDB.
- Container restart preserves Mac identity, cookies, and localStorage.
- Five consecutive stop/wake cycles; headless Mac identity and font loading.
- WebGL/WebGL2 pixel output, OffscreenCanvas WebGL2, OfflineAudioContext non-silent finite sampling.
- WebGPU adapter available; `canPlayType` for H.264, VP9, AAC, Opus all `probably`.

The codec checks test capability declarations, not full video-decoding stress; the WebGPU check is not a GPU performance test. Both builds reported a 10 GiB storage quota.

For the three seeds, 12 consistency checks across main thread, Worker, cross-origin iframe, HTTP UA/Client Hints, language, CPU, and timezone passed on both builds. For the same seed, the 12 sets of text metrics, WebGL renderer/version/pixels, and screen/window data were identical across builds; the UA/Client Hints Chromium major version changed with the engine upgrade, and the GREASE brand also changed. The release version, CDP version, and web full version are different surfaces, so their values not being identical is not by itself a detection failure.

The font installation check was 20/20 families; CSS `local()` using family names directly loaded only 18/20. Menlo's actual full name is `Menlo Regular`, and Comic Sans MS currently has only Bold. Testing its full name and PostScript name, both builds still could not load these two fonts via CSS `local()`; the cause is not yet identified and cannot be attributed solely to using the family name at call time. The other 18 family names loaded. The initial extension probe conflated "family name discoverable" with "same-name CSS local loadable," triggering an assertion; this was later changed to record the two issues separately, and no font files or browser configuration were modified to eliminate the assertion.

## VNC, proxy, and profile upgrade

Both builds passed mouse clicks and Chinese clipboard paste in the live noVNC UI.
After copying a cleanly stopped 151 Mac profile to 152, cookies, localStorage, and IndexedDB were preserved; the original 151 profile was unchanged. This is an upgrade test on the same host and image environment, not a cross-machine portable-cookies test, and not a downgrade test.

| Proxy scenario | 151 | 152 |
| --- | --- | --- |
| Normal authenticated HTTP proxy, via Hub relay, 12 local HTTP/HTTPS navigations | passed | passed |
| Normal authenticated HTTP proxy, three example.com navigations HTTPS/HTTP/HTTPS | all 200 | all 200 |
| Also enabling `--fingerprint-transparent-proxy` | failed to start; log reported invalid configuration | could start; navigation did not pass |

Transparent mode was first tested on a fictitious domain, where 152 reported `ERR_NAME_NOT_RESOLVED`; a resolvable example.com and an authenticated proxy able to forward public CONNECT were therefore added. 151 still failed to start, and 152 reported `ERR_PROXY_CONNECTION_FAILED`. This proves transparent mode was not usable under these HTTP relay settings; it cannot claim it fails on all proxies, and no improvement in connection reliability was observed. The flag was not added to the default configuration.

The local HTTPS fixture used a self-signed certificate, and the test temporarily ignored that certificate error through CDP; the example.com comparison did not disable certificate verification.

## Timings and size

| Item | 151 | 152 |
| --- | --- | --- |
| Reconnect and load a local page after five stops, milliseconds | 4749 / 4855 / 5048 / 5133 / 5339 | 4751 / 4950 / 5026 / 5189 / 5346 |
| Median time | 5.048 s | 5.026 s |
| Container memory sample for that run | 307 MiB | 287.3 MiB |

This is only a small same-host sequential sample including Hub, license, and page-load overhead; it cannot claim 152 is significantly faster or uses less memory. The browser directory grew by 5,291,501 bytes, about 5.05 MiB.

## Abnormal exit and license

After deliberately sending `Browser.crash` to the 151 main process, Hub cleaned up the local browser and display processes, but the server still counted 1/1, blocking subsequent starts. Directly launching the official binary as a control also exited after briefly opening CDP, with exit code 76; a CDP port appearing does not mean the license check ultimately passed.

In the [maintainer reply on issue #477](https://github.com/CloakHQ/CloakBrowser/issues/477#issuecomment-5132347894), the vendor confirms: a session left by a hard crash on the free tier waits up to 15 minutes to expire automatically, while a normal close releases immediately. This is an upstream session policy, so the 503 that 152 received during the wait cannot be counted as a 152 engine regression. This run first observed occupancy returning to zero at UTC 00:37:53, about 15 minutes after the failure at about 00:22:45 (polled every 10 seconds). Afterwards the same CDP URL could restart the original profile; but a localStorage value that was written and then hard-crashed immediately read back as null, failing that persistence assertion. The test did not confirm before the failure that the write had reached disk, so it cannot represent persistence after a normal close.

The main-process hard-crash injection was done on 151; the same 15-minute server-reservation experiment was not repeated on 152. Both builds' normal stop, auto-wake, and container-restart recovery were tested separately.

## Scope limits and build changes

This comparison did not test real business accounts, cross-host cookie migration, downgrading a 152 data directory back to 151, long stress loads, ARM64 runtime, or a real MacBook comparison. Proxy tests covered only local test proxies; they do not represent success rates of residential/datacenter proxy providers. The display remained DPR 1; 4K/DPR 2 was not verified. Complete font families do not mean all weights, glyphs, or font interfaces exactly match a real Mac.

The standard and custom font Dockerfiles now pin `152.0.7977.82.1` / `preview`. The installer accepts exact Chromium versions and explicitly passes `CLOAKHUB_BROWSER_CHANNEL`; it retains exact-version mismatch rejection, atomic cache publication, and official signature verification. `151.0.7922.108.6` / `stable` can be selected explicitly. New profiles default to Mac; existing profiles' persona and seed are not rewritten.

Local tags `cloakhub:mac-preview`, `cloakhub:mac-private`, `cloakhub:mac-standard` point to this preview image. No images were pushed, no release was published, and no existing service was replaced. Both test containers were stopped; before shutdown there were no leftover browsers, display processes, or zombie processes, and the final license occupancy was 0/1. See [Mac fonts and image builds](private-macos.md) for operations.

Raw logs, test scripts, pages, and screenshots are kept in the local ignored directory `.cloakhub/mac-channel-comparison/`. Raw material containing IPs, visitor identifiers, or tokens is not written into this report.
