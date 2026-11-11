# Running a licensed CloakBrowser build

The published image bakes a license-free browser and runs with
`CLOAKHUB_LICENSE_MODE=none`, so most deployments never need this page. It applies
only when you mount an official, licensed CloakBrowser build instead (for example the
bundles described in [`binaries/cloakbrowser`](../binaries/cloakbrowser/README.md)).
CloakHub does not download browsers; you provide the binary.

## Enable it

1. Mount the complete extracted browser directory (not just `chrome`) and point
   `CLOAKHUB_BROWSER_BIN` at its executable.
2. Set `CLOAKHUB_LICENSE_MODE=required` (the default outside the image).
3. Provide keys, preferably as a file mounted read-only, for example at
   `/run/secrets/cloakbrowser-keys`, with `CLOAKHUB_LICENSE_KEYS_FILE` set to that path.

```yaml
services:
  cloakhub:
    image: ghcr.io/txchen/cloakhub:1.0.0
    environment:
      CLOAKHUB_LICENSE_MODE: required
      CLOAKHUB_BROWSER_BIN: /opt/licensed-browser/chrome
      CLOAKHUB_LICENSE_KEYS_FILE: /run/secrets/cloakbrowser-keys
    volumes:
      - ./data:/data
      - ./licensed-browser:/opt/licensed-browser:ro
      - ./secrets/cloakbrowser-keys:/run/secrets/cloakbrowser-keys:ro
```

Keep the key file mode `600` and its directory private. `secrets/` is excluded from Git
and the Docker build context.

## Configure keys

Resolution order (first configured source wins):

1. `CLOAKHUB_LICENSE_KEYS`: JSON string array, e.g. `["KEY_A","KEY_B","KEY_C"]`.
2. `CLOAKHUB_LICENSE_KEYS_FILE`: newline-separated secret file.
3. `CLOAKBROWSER_LICENSE_KEY`: single-key environment setting.
4. `~/.cloakbrowser/license.key`: single-key file.

Empty or malformed explicit sources fail at startup. Blank lines in the key file are
ignored, and repeated keys are deduplicated. Restart the Hub after changing keys or
subscription limits. With no key configured, the Hub starts without a license pool and
leaves validation to the browser.

Key values are not written to profile records, launch arguments, launch metadata or API
responses. Each browser receives its allocated key in `CLOAKBROWSER_LICENSE_KEY`; the
display and stream processes receive no license environment variables. This is secret
handling, not user isolation: the Hub administrator and processes with the same OS
privileges can read process credentials and mounted files.

Each key has a persistent browser HOME at `<Data Root>/license-homes/<SHA-256 of key>`,
created with mode `700`; XDG config, cache, data and state paths point inside it. The
same key reuses that directory across profiles and Hub restarts, so keep
`license-homes` in data backups to preserve the browser's installation identity.
Profile user data, cookies and storage stay with their profiles when key allocation
rotates.

## Concurrency and failures

The Hub reads each key's quota from the official `/api/license/session/count` endpoint.
Its effective Running Instance Limit is the smaller of `CLOAKHUB_MAX_RUNNING_INSTANCES`
and the sum of readable key limits at startup; if no key has a readable quota, startup
fails. Three keys each returning a limit of one provide up to three concurrent Browser
Instances; configuring three strings does not by itself grant three seats. Idle
preemption applies to this effective limit.

Before each launch the Hub refreshes quotas and serializes local reservations, rotating
between keys with free seats. Keys whose quota cannot be read are skipped; unknown
counts are never treated as unlimited. A seat is returned when the browser process
actually exits (or when spawning fails), not when stop is requested. Browser.close
remains the stop path so Chromium can persist storage and release its server-side
session.

The upstream count is a snapshot, not an atomic allocation API: another host can race a
launch, and a crashed process can hold an upstream seat for a while. The Hub never resets
upstream counters, and its reservations are per Hub process, not a distributed scheduler.
The browser itself still validates each key; its exit codes are reported as concurrency
exceeded (76) or validation unavailable (78), both retryable capacity errors, and
invalid or expired key (77).
