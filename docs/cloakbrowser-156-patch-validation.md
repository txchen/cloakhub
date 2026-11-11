# CloakBrowser 156.0.8078.47.1 patch validation

## Scope

Scripts:

- `scripts/patch-cloakbrowser-156-nolicense.sh` (Linux x64)
- `scripts/patch-cloakbrowser-156-arm64-nolicense.sh` (Linux arm64)

These follow the three-edit approach in the 154 scripts (x64 history at
`d8b152e`, arm64 in the working tree): bypass native LicenseRuntime session
startup, replace its fingerprint-key wait with a key-install tail call, and
supply that key to RendererPreferences. Hub and installer licensing code is
unchanged. Dockerfiles and release assets remain on their existing versions.

Both scripts require the exact original SHA-256 before copying, reject
source/output identity, and check instruction bytes before patching. Original
binaries are retained. Output directories must already exist.

```sh
mkdir -p .cloakhub/patched-156/linux-x64 .cloakhub/patched-156/linux-arm64
scripts/patch-cloakbrowser-156-nolicense.sh \
  binaries/cloakbrowser/156.0.8078.47.1/linux-x64/chrome \
  .cloakhub/patched-156/linux-x64
scripts/patch-cloakbrowser-156-arm64-nolicense.sh \
  binaries/cloakbrowser/156.0.8078.47.1/linux-arm64/chrome \
  .cloakhub/patched-156/linux-arm64
```

Sibling resources are symlinked to the source installation; these directories
are not self-contained release archives.

## Addresses and relocation

| Site | x64 VA | arm64 VA |
|---|---|---|
| Start branch | `0xde79ade` | `0xbf03724` |
| Key-wait entry | `0xde79120` | `0xbf02f28` |
| Key storage | `0xde79140` | `0xbf02f38` |
| SetFingerprintTableKey | `0xde759a0` | `0xbeffa34` |
| RendererPreferences source | `0x8da70de` | `0x7974d08` |

Executable file-offset deltas are **0x1000 for x64** and **0x10000 for arm64**.
Do not use the arm64 delta for x64.

The final arm64 renderer patch uses ADRP/ADD directly into x1, size 32 into
w3, destination `x19 + 0x1f0` into x0, and end pointer into x2. No absolute
pointer descriptor is embedded. The existing copy call is preserved. The
key-install stub tail-branches before any original stack/PAC prologue executes.

## Evidence and limits

- Shell syntax checks passed for both scripts.
- Both outputs generated successfully; byte comparison found changes only in
  the four intended regions for each architecture.
- The arm64 renderer instruction sequence was decoded and its argument
  calculation checked at load bases 0, `0x555555550000`, and `0x7f1234000000`.
  This is a narrow relocation/argument check, **not full browser emulation**.
- x64: two concurrent headless processes with distinct user-data directories,
  each under `unshare -rn`, both returned exit 0 and the expected blank HTML.
  Local logs: `.cloakhub/patched-156/smoke.q2mzte/`.
- Earlier x64 GDB checks observed the table-loaded flag at `0x151a59d0` become
  1 after the patched key-install path, and a 32-byte copy of the key in
  RendererPreferences after the copy call.
- The encrypted table is identical across architectures: size `0x2e17f8`,
  SHA-256 `ac0711a2ea8502cc4b0f016aed7f1dee2317a200129fc68152f4e15a0ffa2551`.
  Its nonce is also identical. The 156 key differs from the 154 key.
- **ARM64 runtime smoke validation passed on `tcoci-1` (aarch64)** using a
  temporary Debian bookworm container. The binary SHA-256 matched the final
  arm64 hash below; `--version` returned CloakBrowser 156.0.8078.47.1.
  Dependencies were installed only in the disposable container, not the host.
  Before browser tests the container was disconnected from its bridge network;
  Docker inspection showed an empty network map (`{}`).
- Two ARM64 processes using separate profiles concurrently loaded a data URL
  and executed JavaScript. Both exited 0; both reported `webdriver: false`
  and a working canvas 2D context. The reported Linux x86_64 persona is browser
  output, not the host architecture (verified separately as aarch64).
- Two further ARM64 processes with separate profiles and debugging ports
  remained running concurrently offline for 75 seconds. Both were stopped by
  the test's timeout (exit 124 as expected), rather than exiting early.
- ARM64 logs were retrieved to `.cloakhub/patched-156/arm64-tcoci-1/`.
  The test container, newly pulled Debian image, and remote temporary directory
  (including all profiles and binaries) were removed after testing. Existing
  deployments were not modified.
- No headed UI or end-to-end anti-detection regression suite was run. The
  75-second survival check is not a long-duration heartbeat regression, and
  the ARM64 test did not inspect the internal table-loaded flag.

## SHA-256

| Architecture | Original chrome | Patched chrome |
|---|---|---|
| x64 | `37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a` | `ef78214b823c9a51b0e05d5761025478ad5206c40d0153a8926a2a4a4e0911be` |
| arm64 | `7c50c3274a1aa7fef9f3399f4609b56ba5c5e34e1455f03782145289fda87082` | `54f0547c5223a963d15dba6999403c22ea8f1042667433af387a88c095886364` |

The earlier arm64 prototype used an unrelocated absolute pointer. It was
replaced with the corrected output, including `/tmp/patched-arm64/chrome`.
Use only outputs matching the final hash above.
