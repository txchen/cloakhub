# CloakBrowser 151 deployment

The Docker default is CloakBrowser **151.0.7922.108.4**, Linux identity, headed mode,
1366×768, four CPU threads, and the kernel-generated User-Agent. Existing profile
settings are retained. CDP URLs, authentication, Playwright clients, and profile APIs
are unchanged. Changing the selected key does not change the profile's seed or storage.

## Deploy the published image

Use `ghcr.io/txchen/cloakhub:0.6.0` with the [Compose configuration](../compose.yml)
and [deployment instructions](../README.md#docker). No local build is required.
The image supports amd64 and arm64; Docker selects the host architecture.

## Configure keys

Prefer a file outside the image, mounted read-only at `/run/secrets/cloakbrowser-keys`,
with one key per line. Set `CLOAKHUB_LICENSE_KEYS_FILE` to that path. For example,
a household can configure three independently held keys this way; CloakHub does not
create accounts or change upstream entitlements. Keep the file mode `600` and the
containing directory private. `secrets/` is excluded from Git and the Docker build context.

Resolution order (first configured source wins):

1. `CLOAKHUB_LICENSE_KEYS`: JSON string array, e.g. `["KEY_A","KEY_B","KEY_C"]`.
2. `CLOAKHUB_LICENSE_KEYS_FILE`: newline-separated secret file.
3. `CLOAKBROWSER_LICENSE_KEY`: existing single-key environment setting.
4. `~/.cloakbrowser/license.key`: existing single-key file.

Empty or malformed explicit sources fail at startup. Blank lines in the secret file are
ignored. Repeated keys are deduplicated. Restart Hub after changing keys or subscription
limits. Key values are not written to profile records, launch arguments, launch metadata,
or API responses. Each browser receives its allocated key in `CLOAKBROWSER_LICENSE_KEY`;
owned display processes receive no license environment variables. This is secret handling,
not user isolation: the Hub administrator and processes with the same OS privileges can
read process credentials and mounted files.

## Concurrency and failures

Hub reads each key's quota from the official `/api/license/session/count` endpoint.
Its effective Running Instance Limit is the smaller of `CLOAKHUB_MAX_RUNNING_INSTANCES`
(default 10) and the sum of readable key limits at startup. Three keys each returning a
limit of one provide up to three concurrent Browser Instances. A key returning three
can provide three by itself. Configuring three strings does not itself grant three seats.
Existing idle preemption applies to this effective limit.

Before each launch Hub refreshes the quotas and serializes local reservations. Allocation
rotates between available keys. Keys with rejected/unavailable quota responses are skipped;
if no keys have readable quota at startup, startup fails. Unknown/null counts are not
interpreted as unlimited. An unavailable key cannot prevent allocation from another usable
key, although the first configured key must work for an uncached official download.

A local lease is returned after actual process exit, or if spawning fails before a process
exists. Calling stop/kill alone does not free it. Browser.close remains the preferred stop
path, allowing Chromium to persist storage and release its server-side session.

Observed external usage is reserved conservatively while local instances remain running.
The upstream count is a snapshot, not an atomic allocation API: another host may race a
launch, and a crashed process can leave a temporarily occupied upstream seat. Hub never
resets upstream counters. The binary still validates and heartbeats each key. Its rejection
codes are reported as concurrency exceeded (76), invalid/expired key (77), or validation
unavailable (78), including a rejection after CDP becomes ready. Quota exhaustion is a
retryable capacity error; retry after the upstream seat clears. Local reservations are
per Hub process, not a distributed scheduler.

## Image, download, and version pin

The image contains KasmVNC, fonts, Chromium libraries, Bun, an init process, and the official
JS package **cloakbrowser 0.5.10**. Bun runs the downloader and its Ed25519/SHA256 verification
using Node-compatible crypto APIs; no Node runtime is needed. The only required package
dependency is `tar` and its small dependencies. Optional Playwright/Puppeteer peers are not
installed in the production image. Python and pip are not included.
The image contains neither a license key nor a Chromium binary.
On the first start, the wrapper downloads directly from official channels and verifies
its signed manifest/checksum. Cache location: `<Data Root>/browser-cache` (Docker:
`/data/browser-cache`). Keep the data volume across container replacement.

Cached exact releases are reused, without automatic browser updates. An OS `flock`
serializes installers using the same cache, including the earlier Python implementation.
Existing `chromium-<version>-pro` cache directories are reused without downloading again.
New installs use a temporary directory, then atomically publish the completed directory
after signature/checksum verification, version matching, and extraction succeed. The initial install needs network access and
roughly 745 MiB for the extracted browser plus archive/extraction headroom; reserve at least
2 GiB of free space. Keys are still validated by the browser during normal use.

The upstream free plan downloads only the current stable release and ignores exact download
pins. If that release differs from `151.0.7922.108.4`, Hub fails instead of silently opening
profiles with a new build. Set `CLOAKHUB_BROWSER_VERSION` to an explicitly reviewed exact
151 release, or mount an already obtained binary and set `CLOAKHUB_BROWSER_BIN`. The latter
bypasses the installer and leaves binary version selection to the operator. A non-executable
explicit path fails; Hub does not silently substitute another browser.

Docker sets `CLOAKHUB_BROWSER_INSTALLER=bun`. Local development without that setting retains
explicit binary/PATH discovery. An explicit `CLOAKHUB_BROWSER_BIN` always overrides installation.
The Docker runtime installer replaces the v1 no-runtime-download policy described in
[ADR 0010](adr/0010-cloakbrowser-only-binary-discovery.md). Public image publishing still
requires no license secret in CI.

Official licensing reference: [CloakHQ Binary License](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).
The current terms permit combining paid subscription limits and restrict multiple-account
free-trial abuse. Internal images and public redistribution have different terms; downloading
at deployment avoids bundling the binary in CloakHub's published image.

## Upgrade and rollback

Before using 151 with an existing 146 installation:

1. Stop the old Hub and confirm all of its browser processes have exited.
2. Back up the **entire Data Root**, including profile directories and the SQLite database,
   while stopped. Use a backup process that can read the root-owned browser files and
   preserve permissions; confirm it completes without errors. Keep the old image reference too.
3. Start the new image with that data volume and the key file. Check important existing
   profiles before allowing routine use.
4. For rollback, stop 151, restore the stopped backup into a separate/empty Data Root,
   and use the previous image. Do not run 146 on profile data already upgraded by 151.

CloakHub does not silently back up or rewrite existing data at server startup. An isolated
146→151 migration preserved cookie, localStorage, and fingerprint seed, and restoring a
complete 146 backup into a separate Data Root preserved them on 146 as well. This is not
a test of every existing profile, extension, or login; retain a verified backup.

## Measured image footprint (Linux amd64)

| Artifact | Compressed image content | Unpacked image layers | Browser files in data volume |
| --- | ---: | ---: | ---: |
| Released 0.5.0, bundled 146 | 648.6 MiB | 1,988.7 MiB | Included in image |
| Initial 151 integration | 301.0 MiB | 857.0 MiB | About 745 MiB |
| 151 with Python downloader-only dependencies (previous) | 253.1 MiB | 718.5 MiB | About 745 MiB |
| 151 with Bun + official JS downloader (current) | **231.8 MiB** | **651.2 MiB** | About 745 MiB |

On this machine Docker uses the containerd image store: `docker image inspect .Size`
reports compressed content, and `docker image ls` shows a larger disk figure that includes
both compressed blobs and unpacked snapshots. These are different measurements. The
current image plus installed browser has roughly 1.36 GiB of unpacked logical content, before
profile data; Docker may retain its compressed layers in addition. Shared layers and
filesystem allocation affect actual incremental disk usage.

See [Bun installer verification](../refs/cloakbrowser-bun-installer-2026-09-09.md) for the
current image and [151 integration verification](../refs/cloakbrowser-151-integration-2026-09-09.md)
for the initial migration, key allocation, and earlier image measurements.
