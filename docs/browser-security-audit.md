# Preview CloakBrowser startup outbound audit

Audit date: 2026-09-21. Subject: this repository's preview `152.0.7977.82.1` / Linux x64;
not a security certification of all CloakBrowser versions or all runtime paths.

## Verdict

The binary does contain vendor-added license runtime code and actively contacts CloakBrowser. The license itself and correlatable runtime metadata leave the machine. The license protocol observed so far has no business URL, Cookie, password, or page-content fields, but a limited black-box test cannot prove a closed-source binary never collects these under all conditions.

For company-sensitive business, do not treat "using a browsing proxy" or the vendor's "no telemetry" statement as a guarantee that no data leaves the network: license requests bypass the browsing proxy by default, and the Hub has its own independent seat query. Treat the license service as an external data recipient that must be assessed and controlled.

## Subject and evidence

- Repository audit baseline: `a15f7e11b64cfca6bd77d40b42dd0d27c2570634`.
- npm wrapper: `cloakbrowser@0.5.10`; the Hub uses only its downloader and launches the binary directly at runtime.
- Default version and channel come from [Dockerfile](../Dockerfile); installation policy in [browser-installer.ts](../src/browser-installer.ts). An existing executable cache is reused directly; new downloads perform official signature and hash verification. This audit did not re-download or claim to re-verify the original archive signature.
- Actual file: `.cloakhub/mac-channel-comparison/preview/data/browser-cache/chromium-152.0.7977.82.1-pro/chrome`.
- ELF Build ID: `8fcb7825adc9402e3a5467a82ec412d24c58a576`.
- SHA-256: `ff40f31c74bcca34b46118848c2bcc21602433749b5da3d40763d65576d4b4b4`.
- The binary keeps symbols, including `ungoogled::LicenseRuntime::{Start,BuildRequestJson,MakeLoader,SendHeartbeat,End}`, and source path `components/ungoogled/license_runtime.cc`. Protocol analysis used both the disassembly of these functions and real network requests, without modifying the binary or simulating a license pass.

Tests used temporary Docker containers, an isolated HOME, and fresh profiles, without mounting company business profiles. Only an existing license was used against the originally authorized vendor service, first confirming no active seats, then starting serially and exiting normally. NetLog used `Everything` mode, including application-layer bytes before TLS encryption; the second round disabled QUIC so HTTP/2 request bodies could be decoded directly from `SSL_SOCKET_BYTES_SENT`. No MITM certificate was used and TLS certificate verification was not disabled. The normal path also kept default QUIC behavior as a control.

Raw material is in the local ignored directory `.cloakhub/security-audit/`, containing sensitive information such as license, lease, and TLS keys, and should not be shared or committed directly. Share this report and `summary-redacted.json`.

| Experiment | Observation |
| --- | --- |
| fresh profile, headless, default network, ~45 s | `start`, `end`, normal exit 0 |
| headless, unusable browsing proxy, QUIC disabled, ~325 s | `start`, `heartbeat` at 300.817 s, `end` at 324.576 s; normal exit 0 |
| headed, KasmVNC, default network, ~45 s | browser `start`, `end`, normal exit 0; additionally observed Xvnc STUN traffic |
| headless, unusable proxy, plus `--license-through-proxy` | only attempted to connect to `127.0.0.1:9`; request failed, binary exited 78, no direct fallback observed |

The public HTTP(S) requests in the browser NetLog of the first three rounds all pointed only to `cloakbrowser.dev`. The second round also had manually triggered loopback page and favicon requests. The headed round used `strace -f` to trace the browser and children and container-level pcap to inspect startup traffic; at the system layer, DNS and the Xvnc STUN below were also observed. Thus "public HTTP(S) only to the vendor domain" does not equal "no other network packets." One headed test failed before browser initialization due to a temporary display-argument binding conflict; retesting with the repository's display-listening arguments passed, and that failed material is kept separately and not counted as a successful startup sample. License occupancy returned to 0/1 after all experiments.

## Addresses and actual contents

The hosts of the following three native interfaces are all `https://cloakbrowser.dev`:

| Call | Purpose | JSON fields |
| --- | --- | --- |
| `POST /api/license/session/start` | start and request a lease | `license_key`, `install_id`, `instance_id`, `platform`, `version` |
| `POST /api/license/session/heartbeat` | renew lease | `license_key`, `install_id`, `instance_id`, `lease_id` |
| `POST /api/license/session/end` | release lease on normal exit | `license_key`, `install_id`, `instance_id`, `lease_id` |

Redacted sample of the start request:

```json
{
  "install_id": "[REDACTED UUID]",
  "instance_id": "[REDACTED UUID]",
  "license_key": "[REDACTED LICENSE]",
  "platform": "linux-x64",
  "version": "152.0.7977.82"
}
```

`license_key` is the full key, not a hash; HTTPS protects transport, but the vendor's TLS termination can see it in plaintext. `install_id` is stored in `.cloakbrowser/install_id` under the test HOME and enables cross-process correlation; the relevant initialization function in this binary calls random UUID generation, so it should not be called a hardware fingerprint or `/etc/machine-id`. `instance_id` identifies the process session, and `lease_id` comes from the server response. The vendor can also observe the egress IP, timing, and session duration from the connection. When the second round and headed round used different profiles but reused the test HOME, the response's install ID was the same and instance IDs differed, confirming this cross-profile install-level correlation.

Although the startup argument was the macOS persona, the body still sends the real build platform `linux-x64`. The HTTP request headers contain the persona's User-Agent:

```text
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36
```

So it cannot claim that no configuration-related information egresses. The sample had no JSON fields such as fingerprint seed, GPU, timezone, or proxy password; the actual request headers must also be included in the data inventory, not just the JSON.

The server start response contains `valid`, `lease_id`, `plan`, and a signed `token`, and for this free-license test specified `heartbeat_interval_seconds: 300` and `lease_ttl_seconds: 900`. These are server-issued values for this run and are not guaranteed for other plans or future versions.

## Other outbound connections of the headed runtime stack

Container-level packet capture found `stun.l.google.com:19302/UDP`. It comes from **KasmVNC 1.3.3's Xvnc**, not from the browser's license or browsing-page requests. This packet was a 20-byte STUN binding request with zero attribute length; it contains no license, URL, or Cookie, but the STUN provider can observe the public IP, port, and request time. This is a UDP protocol, with no corresponding HTTP URL.

This behavior matches the version's [Xvnc initialization source](https://github.com/kasmtech/KasmVNC/blob/0ebbbc6412e131092308cc1ce10b9d106e3b4e05/unix/xserver/hw/vnc/vncExtInit.cc#L208) and [STUN implementation](https://github.com/kasmtech/KasmVNC/blob/0ebbbc6412e131092308cc1ce10b9d106e3b4e05/common/network/iceip.cxx#L41). The source's default fallback order is:

1. `stun.l.google.com:19302`, then `stun1.l.google.com` through `stun4.l.google.com`, same port.
2. `stun.voipbuster.com:3478`, `stun.voipstunt.com:3478`.

Only the first Google endpoint was observed this time; the other fallback endpoints cannot be written as connections that occurred. Configuring Xvnc with a suitable explicit `-publicIP` can skip automatic discovery, or `-stunServer` can point to an internal service; the configuration change and its VNC verification were not performed in this audit. Note that `udpPort=0` in this version means reusing the WebSocket port, **not disabling UDP/STUN**.

Also observed were DNS queries to `1.1.1.1:53`; they come from the DNS configuration inherited by this test container's `/etc/resolv.conf`, and cannot be called a hard-coded reporting address of CloakBrowser. The DNS resolver sees the queried domain. No browser HTTP(S) request to Google was observed this time.

## Additional requests from the Hub and installer

These should not be conflated with the native browser protocol:

| Address | Content | Trigger condition and evidence |
| --- | --- | --- |
| `POST https://cloakbrowser.dev/api/license/session/count` | JSON `{ "license_key": "…" }` | Hub initializes capacity at startup and queries launch seats each time; [browser-license.ts](../src/browser-license.ts) |
| `POST https://cloakbrowser.dev/api/license/validate` | JSON `{ "license_key": "…" }` | Installer calls wrapper validation, affected by wrapper cache |
| `GET https://cloakbrowser.dev/api/download/version?channel=preview` | `X-Platform: linux-x64`; channel query parameter | version discovery at install time, affected by cache |
| `GET https://cloakbrowser.dev/api/download/<version>` | `Authorization: Bearer <license key>`, `X-Platform` | download binary, may follow a server download redirect |
| `GET https://cloakbrowser.dev/releases/pro/chromium-v<version>/SHA256SUMS` and `.sig` | version number in the URL | checksum manifest and signature of a new download |

The last four come from the locally installed `node_modules/cloakbrowser/dist/{license,download}.js`; they were not reinstalled this time, so they are not part of this native startup capture. The final download redirect target was not re-collected, so the table should not be read as the complete outbound allowlist needed for a cold install.

The Hub does not execute download callbacks on a cache hit; the installer subprocess sets `CLOAKBROWSER_AUTO_UPDATE=false`. The public wrapper also has npm update checks and optional GeoIP features, but this project launches the binary directly, so the existence of those features cannot be used to assert that the current startup accesses npm, ipify, or GeoLite.

## Proxy, sensitive data, and boundary verdict

After setting the browser to `--proxy-server=http://127.0.0.1:9` (unusable proxy), native still successfully requested a lease from the vendor, proving the default license request bypasses that browsing proxy. Hub's `session/count` likewise does not use the profile's browsing proxy; adding a flag to the browser cannot automatically handle the network egress of the Hub and installer.

In this version, `--license-through-proxy` was measured to route the license start request through the specified proxy: with the same unusable proxy, NetLog only recorded the connection attempt to that proxy, returned network error -130, and the browser exited 78. This negative control did not verify all proxy types, authentication methods, or heartbeat failure cases. The flag itself has [official documentation](https://github.com/CloakHQ/CloakBrowser/blob/11c76ebe7530d51488a73ef0f4b1aa5a080d77b9/README.md#L755).

The manual test page was served only on the container loopback, containing distinct URL, HttpOnly Cookie, localStorage, password input, and page-text markers, all confirmed via CDP to be actually set. The page was loaded after the second round started; these markers were not found in the subsequent heartbeat/end request bodies or the captured outbound TLS plaintext. This experiment did not cover startup recovery with existing business data. They were used to look for direct leakage indications and are not equivalent to a full data-flow analysis; encrypted, hashed, delayed, or conditionally triggered collection could still bypass this detection. No real company site, real account, or browser-extension workload was executed.

The vendor's [privacy statement](https://cloakbrowser.dev/legal/) acknowledges license metadata reporting, claims no browsing data is uploaded, and that session metadata is retained at most 24 hours. This is recorded here as a vendor commitment, without independently verifying its server-side storage, logging, subcontractors, or deletion behavior. The public wrapper's source and download signature verification cannot prove the closed-source native binary has no other data-collection paths.

For company environments, the following go-live conditions are recommended:

1. Explicitly accept the scope of the full license key, install/session identifiers, platform, version, User-Agent, egress IP, and runtime duration leaving the network, and require the vendor to specify how these data and logs are retained and processed.
2. Uniformly restrict egress of the browser, Hub, and installer at the container/network layer; where the company requires an audited proxy, verify that license traffic is also controlled and handle Xvnc's STUN and DNS egress. Allowing only the domain still cannot constrain the request content sent to that domain.
3. Isolate sensitive profiles from other systems, restrict file mounts and environment variables injected into the browser, and use the minimum credentials needed for the business. The current launcher uses `--no-sandbox`, so container isolation must be treated as an important boundary; this is not itself a finding of malicious behavior.
4. Pin the binary hash and redo startup, renewal, exit, and representative business-scenario tests on every upgrade; if the company cannot accept external license networking or closed-source execution risk, the current build does not meet that constraint.

No business code, production service configuration, or license logic was modified in this audit.

## Additional experiment: self-signed certificate and local mock server

Per user request, tested on 2026-09-21 with the same SHA-256 binary. Generated an RSA 2048 / SHA-256 self-signed certificate with CN and SAN both `cloakbrowser.dev`, valid for two days. The certificate includes CA trust-anchor usage and serverAuth; used only for this isolated test.

- Certificate: `.cloakhub/security-audit/selfsigned/certs/server.crt`.
- SHA-256 fingerprint: `3B:CC:2F:37:A6:0E:28:DA:C3:BD:88:4D:DF:8F:DF:1F:B9:0B:37:EE:34:8B:06:BF:AB:F3:E4:80:38:7F:94:72`.
- Experiment scripts and results: `.cloakhub/security-audit/selfsigned/{experiment.mjs,results.json,network-summary.json}`.

Only in the temporary container `/etc/hosts`, `cloakbrowser.dev` was mapped to `127.0.0.1`, with the local HTTPS service listening on 443. After installing test tooling, the Docker bridge was disconnected; during the experiment the container had no external network interface or route. A fixed fictitious license was used, and no real license file was mounted. Each round used an independent HOME/profile, explicitly disabled QUIC, and did not set a parameter to ignore certificate errors. The trust experiment imported the certificate only into the test HOME's NSS database, without modifying the host trust store.

| Condition | Server actually received HTTP request | Binary result |
| --- | --- | --- |
| self-signed certificate not imported into trust store | 0 | exited 78 after ~0.52 s; NetLog error -202 (certificate issuer untrusted) |
| trust the certificate; return `valid:true`, lease fields, no token | 1 `/api/license/session/start` | exited 78 after ~0.49 s |
| trust the certificate; return `valid:true`, provide a token signed with a local Ed25519 private key | 1 `/api/license/session/start` | exited 78 after ~0.50 s |
| trust the certificate; negative control returning `valid:false` | 1 `/api/license/session/start` | exited 78 after ~0.62 s |

The JSON fields received by the server in the last three rounds were all `install_id`, `instance_id`, `license_key`, `platform`, `version`, and TLS reported no certificate error. Each round exited naturally without reaching the 25-second experiment timeout; no binary or official authorization state was modified.

**Conclusion: the current license connection path accepts a self-signed certificate from the test trust store; the certificate layer can pass, but the above self-built license responses still cannot make the binary run normally.** A later re-check found that this round's mock signature used ordinary Base64, so the exit result alone cannot assert it reached signature verification; see the next section for the encoding correction and the controlled experiment distinguishing parse/verification failure. The response disassembly shows the built-in `kLeaseTokenPublicKey`, `ED25519_verify`, and verification of license hash, install ID, instance ID, expiry, etc., consistent with the experimental result of rejecting locally signed responses. No attempt was made to modify the built-in public key, disable license verification, or find other authorization-bypass paths.

Another security implication: **the request content is already sent to the server before the lease response is verified.** Thus the license response's digital signature protects authorization authenticity but cannot prevent a middle party that holds a client-trusted certificate and controls the target traffic from receiving the license. This experiment sent only a fictitious key. This conclusion is limited to the current version and this network path and cannot be generalized to other versions, interfaces, or operating systems having the same certificate trust policy.

## Re-check: real traffic, encoding correction, and signature-only-variable control

Per user request, re-captured connecting directly to the official service's startup and normal exit, and compared using the heartbeat response actually captured earlier. New evidence is in `.cloakhub/security-audit/protocol-check/`. Shareable files are `wire-samples-redacted.json`, `token-verification-summary.json`, `differential-results.json`, and `normalized-original-results.json`; other raw exchanges, NetLog, recovery responses, etc. may contain real keys/leases and are kept only in a restricted local directory.

### Mock issues found and the real format

The previous round's local signature used `toString('base64')`, actually generating a signature containing `+` and `/`. The official token's two segments are both **URL-safe Base64**; the real signature uses `-`, `_`, and preserves the required `=` padding. The old mock may have failed at Base64UrlDecode first, so attributing it directly to signature verification based only on the exit code was not rigorous. The mock has been corrected.

The real token structure is `base64url(JSON UTF-8 bytes).base64url(64-byte Ed25519 signature)`, only two segments, not a three-segment JWT. The real JSON is compact with keys in lexicographic order; times use UTC `+00:00`, and this sample has microseconds. The actual signature covers **the decoded original JSON bytes**, not the Base64 string. After JSON reordering or re-serialization, the original signature can no longer be used.

The 32-byte public key read from the binary's built-in `kLeaseTokenPublicKey` was verified with an independent Node/Bun crypto implementation: both the real start/heartbeat tokens verified successfully; verification using the encoded string as the message failed for both. This is cryptographic verification beyond the response disassembly and does not depend on the vendor's verbal statement.

Real start response, HTTP 200, after redaction:

```json
{
  "valid": true,
  "lease_id": "[REDACTED]",
  "heartbeat_interval_seconds": 300,
  "lease_ttl_seconds": 900,
  "plan": "free",
  "token": "[REDACTED]"
}
```

The decoded token JSON fields are `expires_at`, `install_id`, `instance_id`, `issued_at`, `lease_id`, `license_key_hash`, `plan`, `platform`, `version`. In start, platform is `linux-x64` and version is `152.0.7977.82`. The actual heartbeat response's outer layer has no start's `lease_id` and `plan` fields, though both still exist in its signed payload; in that heartbeat payload, `platform` and `version` are empty strings. The normal end response is `{"ok":true}`. These responses cannot simply use the same JSON template.

Also, this relay received the official response with `Content-Encoding: zstd`, so undecoded bytes cannot be parsed as JSON. The first relay attempt failed here; zstd decoding was added, and the raw response is saved before parsing. The test session created that time was retried for a lease via the same install/instance ID, then released normally, confirming occupancy returned to 0/1 before continuing the later experiments.

### Differential experiments over the same HTTPS path

Continuing in the temporary container with the above self-signed certificate and local hosts mapping. When the relay made requests to the real official service, it obtained the official address via normal DNS resolution, with TLS hostname still `cloakbrowser.dev`, retaining server certificate verification; only license-related endpoints were allowed. The binary, public key, certificate error handling, or license code were not modified. Real credentials were used only for official authorized requests, while full mocks used a fictitious license. Each experiment used an independent HOME/profile.

| Control | Verification and observation |
| --- | --- |
| Forward the official compressed response as-is | forwarded body byte-identical to upstream; official signature valid; still alive 15 s after start and `Browser.getVersion` succeeded, normal close exit 0 |
| Decompress the official response, re-serialize as uncompressed JSON, keep the original token | full JSON semantics unchanged; likewise passed the 15 s alive/CDP check, normal close exit 0 |
| Keep all official fields and token payload unchanged, flip only one byte of the signature | redacted comparison confirmed only one signature byte differed; official public-key verification went true → false; exited naturally 78 after ~1.22 s |
| Keep the official real token payload original bytes, re-sign with the local private key, using correct Base64URL | local public key verified true, official public key verified false; other fields and encoded payload identical; exited naturally 78 after ~1.11 s |
| Full local mock, corrected Base64URL, field order, and time format | still exited naturally 78 after ~0.50 s; no start request for this fictitious license was submitted to the official service |

The second row is a necessary positive control: it shows that decompression, JSON re-serialization, and the corresponding header handling do not by themselves cause the last two rows to fail. The third row avoids confounders such as time format, missing fields, license state, and instance binding; the fourth row further confirms the problem is the signature's trust source.

Thus the attribution of earlier experiments should be corrected, but the conclusion holds under stricter controls: **the current binary can use official legitimate authorization through a locally trusted HTTPS relay; correctly mocking the format and signing locally still cannot replace an officially issued lease.** The positive experiment only verified 15 s after start and CDP availability, not long-term renewal/full business functionality, and is not proof that no implementation defects exist.

Experiments that deliberately corrupt the response first create a lease on the official service, then cause the browser to reject it; the experiment script uses the captured original lease to call the normal end interface for cleanup. After all controls completed, license occupancy was 0/1; no test container was left behind and no host hosts/certificate trust was modified.

The 5-minute offline replay and multi-instance experiments later completed per user request are in the [browser runtime dependency report](browser-runtime-dependency.md). That round launched the binary directly, bypassing the Hub, and separately recorded the results for the original instance continuing to run and new-instance replay failing.
