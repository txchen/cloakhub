# Feasibility of removing the Preview CloakBrowser license phone-home

Date: 2026-09-21. Subject: this repository's preview `152.0.7977.82.1` / Linux x64.
binary: `.cloakhub/cloak152-evaluation/released-cache/chromium-152.0.7977.82.1-pro/chrome`,
ELF Build ID `8fcb7825adc9402e3a5467a82ec412d24c58a576`,
SHA-256 `ff40f31c74bcca34b46118848c2bcc21602433749b5da3d40763d65576d4b4b4`.

This report is a **static-disassembly feasibility assessment**; no modified binary was generated, run, or distributed. For the related network protocol, signature, and exit-code behavior see the [startup outbound audit](browser-security-audit.md) and the [runtime dependency report](browser-runtime-dependency.md).

> Compliance boundary: removing license checks generally violates the vendor's license/terms of service. This only answers "is it technically possible, and where to change", not a recommendation to deploy. If the goal is to eliminate external dependency, obtain a formal offline/self-hosted license from the vendor first; see the risks at the end.

## Conclusion

**Feasible at the runtime level, and the change is small.** The preview binary's license runtime code is concentrated in `ungoogled::LicenseRuntime`; the browser core does not read license state, only the runtime uses it for start, renewal, and exit reporting, and **terminates the process** when validation fails. So as long as `LicenseRuntime::Start` no longer sends a request, the browser runs completely without license gating.

But note the scope: **patching the binary only disables the native runtime's network calls; it does not mean all of CloakHub stops contacting the vendor.** The Hub itself still calls `session/count`, and the installer still does version discovery, download, and validate. To "fully eliminate network egress," all three layers must be handled.

| Layer | Network points | Location | Covered by this binary patch |
| --- | --- | --- | --- |
| native runtime | `session/start`, `heartbeat`, `session/end` | `LicenseRuntime` | yes |
| Hub | `POST /api/license/session/count` | [browser-license.ts](../src/browser-license.ts) `queryLicenseSeats` | no (Hub source) |
| installer | `version`, `download`, `validate` | [browser-installer.ts](../src/browser-installer.ts) / wrapper | no (can be changed to a mounted local binary) |

## Evidence: runtime network surface

`nm` shows the binary is not stripped; the only license-related symbols are the following functions (all in `components/ungoogled/license_runtime.cc`):

| Function | vaddr | Role |
| --- | --- | --- |
| `MakeLoader` | `0xcfe13e0` | Build POST `<api_base><path>`; default `https://cloakbrowser.dev` |
| `Start` | `0xcfe19c0` | Read key/install_id/instance_id and send `session/start` |
| `End` | `0xcfe26f0` | Send `session/end` on exit |
| `SendRequestVia` | `0xcfe3170` | Generic send |
| `OnResponse` | `0xcfe32b0` | Parse, Ed25519 verify, binding/expiry check; exit process on failure |
| `FinishStartRequest` | `0xcfe4f70` | Start-finished callback |
| `SendHeartbeat` | `0xcfe5010` | Renewal, scheduled by the `OneShotTimer` in `OnResponse` |

Built-in constants (first LOAD segment: vaddr == file offset):

| Constant | vaddr | Contents |
| --- | --- | --- |
| `kDefaultApiBase` | `0x2bb7120` | `https://cloakbrowser.dev` |
| `kApiBaseEnvVar` | `0x2bb7140` | `CLOAKBROWSER_LICENSE_API` |
| `kStatusFileEnvVar` | `0x2bb7160` | `CLOAKBROWSER_LICENSE_STATUS_FILE` (only writes exit code) |
| `kStartPath` | `0x2bb7190` | `/api/license/session/start` |
| `kLeaseTokenPublicKey` | `0x2bb71ab` | 32-byte Ed25519 public key |
| `kEndPath` | `0x2bb71d0` | `/api/license/session/end` |
| `kHeartbeatPath` | `0x2bb71f0` | `/api/license/session/heartbeat` |
| `kLicenseKeyEnvVar` | `0x2bb7210` | `CLOAKBROWSER_LICENSE_KEY` |

Response tokens are verified with the built-in public key (verified independently against real samples). So pointing `CLOAKBROWSER_LICENSE_API` at a local fake service is not enough: the local service cannot sign an accepted token, and historical experiments still exited 78 even with correct Base64URL and correct field order.

## External call sites: only two in total

Scanning the 519 MB binary with streaming `objdump -d | grep`, the only locations outside the function bodies that reference the `LicenseRuntime` singleton (`0x14369788` / guard `0x143698e0`) and the three public entries are:

| Call | Function | vaddr | Machine code |
| --- | --- | --- | --- |
| `Start(license_factory=rbx, system_factory=...)` | `ChromeBrowserMainParts::PreMainMessageLoopRun` | `0x87fb13d` | `e8 7e 68 7e 04` |
| `End()` | `browser_shutdown::OnShutdownStarting` | `0x950a3d7` | `e8 14 83 ad 03` |

`SendHeartbeat` is referenced only by the runtime-internal timer bindings (`0xcfe4121`, `0xcfe4bc1`), with no other external entry. That is: **as long as `Start` sends no request, `OnResponse` does not execute, `SendHeartbeat` is not scheduled, and `End` has no loader to send with**, so the runtime's external contact is zero.

The startup call site `0x87fb13d` is immediately followed by `mov r14d,[rbx+0x18]`; `Start`'s return value/blocking does not participate in the browser startup flow — the license check is asynchronous, and the only enforcement is `TerminateCurrentProcessImmediately` in `OnResponse`. This explains why removing `Start` does not affect browser usability.

## Object state and exit codes

Fields of the `LicenseRuntime` singleton (from `Start`/`End`/`OnResponse` disassembly):

| Offset | Meaning |
| --- | --- |
| `0x0` | `license_key` |
| `0x18` | `install_id` (`.cloakbrowser/install_id` under HOME) |
| `0x30` | `instance_id` (per-process UUID) |
| `0x48` | status-file path (writes exit code on failure) |
| `0x60` | `lease_id` |
| `0x78` | `plan` |
| `0x98` | signed `token` |
| `0xb0` | valid lease/token obtained |
| `0xb1` | `Start` already called |
| `0xb2` | `End` / finished flag |
| `0xb3` | start request in progress |
| `0xb8` | license `SharedURLLoaderFactory` |
| `0xc0` | system `SharedURLLoaderFactory` |
| `0xc8` | start retry flag |
| `0xd0` | current `SimpleURLLoader` |
| `0xe0` | heartbeat `OneShotTimer` (initialized at construction) |
| `0x110` | delayed task handle |
| `0x140` | start-finished callback (`QuitClosure`) |
| `0x148`/`0x150` | weak-reference refcount |

Failure exit codes (mapped correspondingly by `browser-process-launcher.ts`): `0x4e`(78) validation unavailable, `0x4d`(77) key invalid/expired, `0x4c`(76) concurrent seats exceeded. These branches are all inside `OnResponse` and are not triggered once `Start` sends no request.

## Proposed patch points

File offset: `.text` (second LOAD: Offset `0x328a000`, VirtAddr `0x328b000`) satisfies `file_offset = vaddr - 0x1000`. The offsets in the table below have all been byte-checked.

### Primary patch (recommended): make `Start` a no-op

The `Start` entry itself already has a branch that "if already called, releases the arguments and returns":

```
cfe19d7: 80 bf b1 00 00 00 00   cmpb $0x0,0xb1(%rdi)
cfe19de: 0f 84 83 00 00 00      je   cfe1a67        ; continue only if 0xb1==0
cfe19e4: ...                    ; release rdx(system factory) and r12(license factory) then return
```

Changing the 6-byte conditional jump at `cfe19de` to NOP makes `Start` **always take the early-return branch**: it normally releases the two `scoped_refptr` arguments, without building a loader, sending a request, writing status, or scheduling a heartbeat.

| Item | Value |
| --- | --- |
| vaddr | `0xcfe19de` |
| file offset | `0xcfe09de` |
| original bytes | `0f 84 83 00 00 00` |
| patched | `90 90 90 90 90 90` |

This is the minimal patch with clean reference counting. `End` is still called, but `0xb8` is now null, so it early-returns at `cmpq $0,0xb8(%r15)` at `cfe2788`, producing no network; it only cancels the timer initialized at construction. With no binding, the heartbeat is not scheduled.

### Alternative patch: NOP the startup call site

If you do not want to modify the function body, you can erase the call in `PreMainMessageLoopRun`:

| Item | Value |
| --- | --- |
| vaddr | `0x87fb13d` |
| file offset | `0x87fa13d` |
| original bytes | `e8 7e 68 7e 04` |
| patched | `90 90 90 90 90 90` |

Same effect, but it leaks one refcount of the system factory (the `inc` at `0x87fb115` happened but is not released by the callee). Harmless for the process lifetime, but less clean than the primary patch.

### Defensive patches (optional)

| Target | vaddr | file offset | original bytes | suggestion |
| --- | --- | --- | --- | --- |
| `End` call site | `0x950a3d7` | `0x95093d7` | `e8 14 83 ad 03` | NOP; not required this round |
| `SendHeartbeat` entry | `0xcfe5010` | `0xcfe4010` | `55 48 89 e5 …` | change first byte to `c3` (ret); not required this round |

Do not directly NOP the `TerminateCurrentProcessImmediately` call inside `OnResponse`: it is immediately followed by an `int3`/`ud2` trap, and erasing the call ends with an exception rather than a normal return. Handling that path requires control-flow redirection, with higher effort and risk; cutting off at `Start` never reaches it.

## Why not take the easier paths

- **Change endpoint via env var**: `CLOAKBROWSER_LICENSE_API` only changes the hostname, not the Ed25519 verification. A local server cannot generate a token accepted by the built-in public key; historical experiments still exited 78 after correct encoding.
- **Cache/replay official responses**: tokens bind `license_key_hash`, `install_id`, `instance_id`, `lease_id`, and `expires_at`; after a new instance changes IDs, verification/binding fails, and multiple new instances have been measured exiting 78.
- **Modify only the Hub**: removing the Hub's `session/count` still leaves the native runtime contacting the vendor itself and possibly being rejected for concurrency; conversely, patching only the binary leaves the Hub's count and the installer still egressing.

## Applied patch and verification results (2026-09-25)

The primary patch has actually been applied and two-way comparison verification completed.

### Artifacts

| Item | Value |
| --- | --- |
| original binary | `.cloakhub/cloak152-evaluation/released-cache/chromium-152.0.7977.82.1-pro/chrome`, SHA-256 `ff40f31c74bcca34b46118848c2bcc21602433749b5da3d40763d65576d4b4b4` |
| patched binary | `.cloakhub/cloak152-evaluation/patched-nolicense/chrome`, SHA-256 `97990530346ff97afa12fb93996659934abb6d6641714384bc126af8721141ca` |
| patch point | vaddr `0xcfe19de` / file offset `0xcfe09de`, `0f 84 83 00 00 00` → `90 90 90 90 90 90` |
| resources | `icudtl.dat`, `*.pak`, `locales/` etc. in the same directory are symlinks to the original directory (`chrome` is a real file) |
| reproducible script | [`scripts/patch-cloakbrowser-license-preview.sh`](../scripts/patch-cloakbrowser-license-preview.sh) |

The script regenerates the patched artifact from the original binary, with SHA-256 matching the table above.

### Verification (network isolation + no license key)

Command shape (`unshare -rn` provides a network-free namespace):

```
unshare -rn env HOME=<tmp> CLOAKBROWSER_LICENSE_KEY=dummy \
  CLOAKBROWSER_LICENSE_STATUS_FILE=<tmp>/status \
  <chrome> --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=<tmp>/ud --dump-dom 'data:text/html,<h1>hello</h1>'
```

| binary | exit code | rendered output | status file |
| --- | --- | --- | --- |
| unpatched original | **78** | none (`--dump-dom` produced nothing) | `78` |
| primary-patched | **0** | `<html>…<h1>hello</h1>…</html>` | not written |

The original binary self-terminates with 78 (validation unavailable) without network, consistent with the prior conclusion; the primary-patched binary starts completely normally and renders the page under the same conditions, without writing a status file, showing that `OnResponse`'s failure-exit branch and heartbeat were not triggered. This verifies the conclusion that cutting `Start` severs the network surface.

### Verification (NetLog `Everything`, real network)

Started with the same dummy key, real network, `--log-net-log=<file> --net-log-capture-mode=Everything`, capturing NetLog and parsing actual events (excluding the constants dictionary at the top of NetLog).

| binary | actual event count | URL_REQUEST | parsed URL | exit code |
| --- | --- | --- | --- | --- |
| primary-patched | 29 | **0** | none | 0 (`--dump-dom` produced output) |
| unpatched original | 144 | 1 | `https://cloakbrowser.dev/api/license/session/start` | 139 (SIGSEGV) |

- Patched events are only local events such as cookie store, QUIC session cleanup, and NetLog close; there is no `URL_REQUEST`, DNS resolution, or HTTP request, and the text contains no `cloakbrowser`.
- The original binary's NetLog explicitly records a request to `cloakbrowser.dev`'s `/api/license/session/start`, with the host resolving to `cloakbrowser.dev`.
- The original binary this time exited 139 (SIGSEGV) on the real network (without writing a status file); previously it was 78 without network. Both are failure/termination behavior on the `OnResponse` path, contrasting with the patched 0, and do not affect the conclusion that the patch severs the network surface.

### Verification (direct launch: normal functionality)

Without a license key, launched the patched binary directly with `--remote-debugging-port` and did a functional smoke test with Playwright `connectOverCDP`. Script: [`scripts/verify-cloakbrowser-patch-smoke.mjs`](../scripts/verify-cloakbrowser-patch-smoke.mjs); original results kept in the local ignored directory `.cloakhub/cloak152-evaluation/patched-verification/`.

All passed: DOM/JS computation, input, click, `localStorage` preserved across reload, HTTP UA consistent with `navigator.userAgent`, cross-origin iframe identity consistent, Web Worker identity consistent, WebGL1/WebGL2 pixels `[64,128,191,255]`, OffscreenCanvas WebGL2, WebGPU adapter available, OfflineAudioContext non-silent, H.264 `probably`, multiple tabs.

### Verification (direct launch: anti-detection)

Using the site set and parsing approach of `examples/antibot-audit.mjs`, rewritten as [`scripts/verify-cloakbrowser-patch-antibot.mjs`](../scripts/verify-cloakbrowser-patch-antibot.mjs) connecting directly to CDP, ran both personas on the patched binary:

| Detection item | patched Linux headless | patched Mac persona headless | documented baseline preview (Mac headed) |
| --- | --- | --- | --- |
| Device & Browser Info | `isBot=false`, all details false | `isBot=false`, all details false | `isBot=false` |
| Fingerprint `bot` | not_detected | not_detected | `bot=not_detected` |
| Fingerprint `tampering` | false | false | `tampering=false` |
| Fingerprint `anomaly_score` | 0.053 | 0 | 0 |
| Fingerprint `anti_detect_browser` | false | false | false |
| Fingerprint `virtual_machine` | false | false | false |
| Sannysoft `failed` rows | 0 | 0 | no failed |
| Rebrowser | mainWorldExecution / exposeFunctionLeak red, the rest green | same | same two red |
| CreepJS | 44% like headless, 0% headless, 0% stealth, 7/51 fonts | **31% like headless, 0% headless, 0% stealth, 2/51 fonts** | **31%, 0%, 0%, 2/51** |
| Iphey | 100 Trustworthy | 100 Trustworthy | 100 Trustworthy |

Mac persona direct results match the documented baseline item by item (the two red Rebrowser items are caused by the script deliberately executing main-world code and `exposeFunction` per the site instructions, not a regression). Linux headless's CreepJS "like headless" and font-probe differences come from a different persona/font environment and do not affect the key "0% headless / 0% stealth" verdict.

In the same environment, stock Chromium headless was run as a control: Device Info `isBot=true`, `isAutomatedWithCDP=true`, `isAutomatedWithCDPInWebWorker=true`, Fingerprint `suspect_score=19`; patched CloakBrowser corresponds to `isBot=false`, `suspect_score=0`.

### Verification not yet done

- **Original binary anti-detection control in the same environment**: no valid license key locally (not in the repo; mounted at runtime via Docker secret), and the original binary self-terminates on the real network, so it cannot be an A/B control under the same conditions; this section substitutes the documented preview baseline + stock Chromium control.
- Real-launcher integration test mounting the patched binary via `CLOAKHUB_BROWSER_BIN`;
- Proxy, extensions, download/upload, KasmVNC headed, etc. have not been black-box accepted one by one.

## Risks and maintenance cost

- **Integrity identifier change**: after patching, SHA-256 / BuildID changes, so any deployment and upgrade verification pinning the binary by hash must be updated accordingly; the ELF itself has no code signature, but the wrapper download verification CloakHub relies on will not match the actual file and must be changed to a local mount path.
- **Upgrade cost**: every new official preview may change function addresses, field layout, and decision branches, requiring the above localization to be redone for that version.
- **Unknown feature gating**: static scanning shows no symbol other than `LicenseRuntime` references license state, so it is inferred there is no "unlock features by license" logic; but this is a static inference and a round of representative CloakBrowser business functionality (fingerprint, proxy, extensions, etc.) black-box acceptance should be added.
- **Hub consistency**: after removing native validation, `LicenseCapacityError`, capacity reservation, and `browser-license.ts` seat queries need to be adjusted together, otherwise the Hub will refuse to start because the count endpoint fails.
- **Compliance**: bypassing license checks most likely violates the vendor's license/terms of service, and the vendor can change the public key, protocol, or check point at any time. To eliminate external dependency long-term and maintainably, the correct path is to obtain a formal offline/self-hosted license or agree on an internal license endpoint with the vendor, rather than patching on every upgrade.
