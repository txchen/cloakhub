# CloakBrowser runtime: official token replay and concurrent startup experiments

Date: 2026-09-21. Version: Linux x64 preview `152.0.7977.82.1`; for the binary hash and the earlier TLS/signature verification see the [security audit](browser-security-audit.md). The test license's server plan was free, single seat; this does not guarantee the lease policy of other plans or future versions.

**This experiment launched the browser binary directly, without going through the Hub and without running the Hub's capacity checks.** The goal was to determine the runtime's dependency on the official service; no business source was modified.

## Results

| Item | Measured |
| --- | --- |
| Official token signature validity | ~900 s, i.e. 15 minutes |
| Official specified heartbeat interval | 300 s, i.e. 5 minutes |
| After obtaining one official response, fully cut off public network while keeping the original instance | observed continuously ~310 s, original instance still operable |
| First heartbeat returned the unchanged startup response | occurred 300.011 s after obtaining the response; still operable up to 310 s afterward |
| Check CDP, load local page, run JS, read/write localStorage every 30 s | 12 checks including initial and final, all passed, storage count incremented from 1 to 12 |
| Two batches of three extra instances each started concurrently, all received the same cached response | all six exited naturally 78, in ~0.84–1.10 s |
| Among the extra instances, four reused the original instance's HOME / install_id | still all failed; instance_id in the requests all different |
| The other two used independent HOME / install_id | likewise failed |

The original instance was closed by the experiment program via a normal `Browser.close`, exit 0; it did not self-invalidate at the 310th second. Only one official lease was requested remotely; the six extra instances' requests were not forwarded to the official service. So their exit cannot be attributed to the official service returning insufficient seats after receiving concurrent requests.

## Validity period and reuse scope

This token's signed payload contained:

```text
issued_at  = 2026-09-21T21:38:54.774528+00:00
expires_at = 2026-09-21T21:53:54.773527+00:00
```

The server returned `lease_ttl_seconds = 900`; the difference between the two signed times is ~899.999 s. This is the lifetime of a single lease token, not the validity of the license key or the whole subscription.

The token binds `license_key_hash`, `install_id`, `instance_id`, and `lease_id`. The same installation and same license do not make different processes the same instance. In the concurrency test, four instances' install_id equaled the original instance's, and all six instance_id differed; the corresponding signed token cannot be used directly for these new processes. This experiment did not rewrite instance IDs, modify the binary, or disable verification.

**The original instance still working after replaying the heartbeat does not mean the old token was successfully renewed.** All returned response bodies in this experiment were byte-identical, and the signed expires_at never changed. The corresponding binary's response-handling disassembly also shows: checking install/instance/lease binding and expiry, and requiring the new expires_at to advance past the recorded value; invalid renewal responses have a separate tolerance/retry path. This static evidence explains why "the process is still alive" cannot be proof of successful renewal, but this experiment did not measure the tolerance path via internal state instrumentation, so the inference cannot be written as a log of actual renewal success or failure.

## Experimental method and evidence

1. In the temporary container, trusted the self-signed certificate from the previous round and mapped `cloakbrowser.dev` to the local HTTPS service. All profiles were empty, using different user-data-dir and CDP ports.
2. Only for the original instance, requested one legitimate lease from the real official service, independently verified the returned token's Ed25519 signature, and saved the full raw response.
3. Removed the container's external network connection with `docker network disconnect`. The recorded Docker network mapping was empty and the IPv4 routing table had no external route; localhost HTTPS/CDP/page services were still available.
4. For subsequent start/heartbeat requests, returned the cached response unchanged, without changing token, validity, heartbeat interval, or lease TTL. Three-instance concurrency appeared at about 1 s and at 151 s after the first start.
5. After isolation, observed continuously for 310 s, covering the actual first heartbeat and the page checks afterward. The cached response was sent eight times: original instance start, six extra instance starts, original instance heartbeat. Each response body's SHA-256 was identical, and the browser NetLog also confirmed it received the same start/heartbeat response body.
6. After normally closing the original instance, restored the test container's network, released the original lease via the official end interface, then queried to see occupancy 0/1, and finally deleted the test container. No host hosts or certificate trust was modified.

Restricted local material is in `.cloakhub/security-audit/replay-five-minutes/`:

- `results.json`, `health.json`: run results and page checks.
- `events-redacted.jsonl`, `browser-received-response-proof.json`: replay times, binding-consistency booleans, and response-body hashes.
- `token-metadata.json`, `isolated.json`, `cleanup-result.json`: validity, isolation, and cleanup.
- `experiment.mjs`, `coordinator.py`, `cleanup.mjs`: experiment scripts.

`*-private.json`, `requests-private.jsonl`, and each instance's NetLog contain real credentials/leases and should not be shared or committed directly. The directory permissions are restricted to the current user.

## Explanation of go-live dependency risk

- **New creation, restart, and scale-out still depend on obtaining an official authorization matching the new instance.** This experiment started six new instances with the same valid token and all failed; caching one response cannot provide offline startup capability for new instances.
- **An already-started instance has room to keep working for a short time.** This experiment's original instance kept working for at least 5 min 10 s under the condition of being completely unable to reach the official service and receiving old responses from a local service.
- **This does not constitute a 15-minute or longer availability guarantee.** This experiment did not run until token expiry, did not measure the exact termination time after multiple failures, and did not treat real-service timeouts, DNS errors, 503s, and returns of old tokens as equivalent. Replay cannot rewrite the official signature's expiry.
- The current evidence does not support using a simple response cache as a runtime disaster-recovery solution. If go-live requires the ability to restart/scale out during a long vendor outage, obtain and verify a formal offline authorization or self-hosted authorization; the maximum failure tolerance of existing processes requires additional fault injection for expiry and real error types.

These conclusions apply only to the browser runtime. The Hub's implementation, fault handling, and whether it bypasses its checks are not part of this result.

## Follow-up experiment: test service actively renews, then shares the latest token

The user further proposed: have the local service keep heartbeat with the official service, cache the latest authorization, and distribute it to multiple browser instances. On 2026-09-21 a complete official heartbeat cycle experiment was completed with the same binary. Still launched the binary directly, without going through the Hub.

The local HTTPS service requested one official lease for the original instance and renewed it at the server-specified 300 s cycle. When a browser request arrived in the same cycle, it waited for the in-progress renewal, avoiding duplicate requests to the official service. New instances' start requests only hit the local cache and did not request additional official leases for them. The whole experiment had one official start and one official heartbeat.

### Official renewal did obtain a new valid token

| Item | First token | New token returned by heartbeat |
| --- | --- | --- |
| issue time (UTC) | 22:00:29.454162 | 22:05:30.065908 |
| expiry time (UTC) | 22:15:29.453042 | 22:20:30.065358 |
| independent verification with binary built-in public key | pass | pass |

The expiry advanced by 300.612 s. The old and new tokens' `license_key_hash`, `install_id`, `instance_id`, and `lease_id` stayed the same, showing the new token continues to authorize the original session. This used the actually newly issued token, without changing time, signature, or instance identifier.

The official heartbeat response's outer layer lacks the `lease_id` and `plan` needed by start, so the service constructed a complete start response outer layer for new instances, retaining the original lease fields and filling in the latest token, heartbeat interval, and lease TTL; the signed token itself was not modified at all. The heartbeat given to the original instance used the real heartbeat response structure, ruling out a simple misuse of response format.

### Both before and after renewal, sharing to new instances failed

| Experiment | Result |
| --- | --- |
| before renewal, three new instances use the initial token | all exit 78, ~0.92–1.18 s |
| after renewal, three new instances use the latest token | all exit 78, ~0.84–1.01 s |
| original instance receives the same latest token | stays usable; all 13 CDP, page, JS, localStorage checks in the ~307 s experiment passed |

In each group of three new instances, two shared HOME / install_id with the original instance and one used a different HOME. All new instances had independent user-data-dir, CDP port, and newly generated instance_id. The original instance was finally normally closed by the experiment program, exit 0.

Independently parsed each instance's actual NetLog, confirming the original instance received the second-generation token in heartbeat, and the three post-renewal new instances received **the same second-generation token** in start, and all three received tokens passed vendor public-key verification. So this round's failure cannot be explained as "cache not yet updated", "received an expired token", or "local signature invalid". The new instance requests were not sent to the official service, and the failure was not this round's official concurrency endpoint returning insufficient seats.

**Conclusion: in this version, actively renewing one official session and then distributing that session's latest token to multiple independent browser instances was measured not to achieve multi-instance.** Official renewal maintains the original session; the instance binding in the signature does not disappear as a result. As an authorization relay for one instance, this path can work; it still requires the official service to keep issuing new tokens and does not eliminate the runtime's official dependency.

This round covered one real five-minute renewal cycle, not proof of long-term stability, all plans, or all possible implementation approaches. The binary, public key, or instance ID were not modified, and no other authorization-bypass path was attempted.

Evidence is in `.cloakhub/security-audit/live-renewal-cache/`: `results.json`, `renewed.json`, `health.json`, `events-redacted.jsonl`, `browser-received-token-proof.json`, `cleanup-result.json` for review. Raw private requests/responses and NetLog contain license and lease and remain restricted to local permissions. After the test, the official end succeeded, seats returned to 0/1, and the temporary container was deleted.

## Separate re-check of the startup API cache

The user pointed out that new instances must receive the complete response of the startup interface, so the previous round's records were re-checked: the fields returned by 7 `/api/license/session/start` calls were all `valid`, `lease_id`, `heartbeat_interval_seconds`, `lease_ttl_seconds`, `plan`, `token`; only `/heartbeat` used the heartbeat response structure. The previous round's startup interface did not directly return a heartbeat packet. Redacted routing evidence is in `live-renewal-cache/response-routing-redacted.json`.

Also added a control without replacing the token or reorganizing the JSON: obtained one new official start response, cached the raw response body, and returned the same bytes to `/start` for the original instance and three new instances. Each browser's NetLog proved all four response bodies' SHA-256 matched the official original, and all signatures were valid; this round did not call the heartbeat interface. The original instance passed CDP and page JavaScript checks during a 15.855 s observation window, and after actively closing exited with code 0; the three new instances exited at 0.932, 0.858, and 1.078 s respectively, all with exit code 78. Two of them reused the original HOME/install_id, one used a different HOME; the three new requests' instance_id all differed from the original instance. This result ruled out failures caused by a missed cached startup response and by reorganizing the response, consistent with the previously found token instance-binding verification. This supplementary test targeted startup and did not repeat the five-minute renewal test.

Evidence is in `.cloakhub/security-audit/start-response-cache-control/`: `results.json`, `browser-received-response-proof.json`, `cleanup-result.json`. The official lease was released, active was 0, and the temporary container was deleted.

## Real-binary verification of per-key HOME isolation

On 2026-09-21, directly imported the modified `src/browser-process-launcher.ts` and launched the same preview binary through the real launcher, using test keys A, B, A, B in turn, each with a different profile. Each time the launcher and license pool were recreated, verifying HOME persistence. The test environment disconnected the Docker external network and used a locally trusted HTTPS endpoint to capture the actual `/api/license/session/start` the binary sent, without connecting to the official service or using a real license. Only the local TLS trust store was initialized; `.cloakbrowser/install_id` was not pre-written or copied.

| Launch | Test key | install_id in the binary request |
| --- | --- | --- |
| 1 | A | `265309b4-f9c3-440c-b594-2198c6559093` |
| 2 | B | `865c8a23-6615-4429-8bbb-69c1eaa1a4c5` |
| 3 | A | `265309b4-f9c3-440c-b594-2198c6559093` |
| 4 | B | `865c8a23-6615-4429-8bbb-69c1eaa1a4c5` |

Different keys had different HOME and install_id; the same key, in a new profile and after recreating the launcher, reused the original HOME and install_id. The install_id in all four requests matched the file the binary itself wrote into the corresponding HOME; all four instance_id differed. 10 checks passed.

This experiment deliberately returned `valid:false`, and all four processes exited 78: what was verified was real install-identifier generation, transmission, and persistence, not a valid-license startup or multi-key official authorization compatibility. Evidence: `.cloakhub/security-audit/license-home-identity/results.json`, `experiment.ts`, `network-isolation.json`. The temporary container was deleted.
