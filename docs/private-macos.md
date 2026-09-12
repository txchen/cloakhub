# Mac fonts and image builds

The standard Dockerfile includes `fonts/macos/`, uses CloakBrowser preview
`152.0.7977.82.1`, and defaults new profiles to `macos`. The GitHub Docker
workflow builds this same Dockerfile for amd64 and arm64, so published images
include the fonts starting with `0.7.0`.

Build from the repository:

```sh
docker build --build-arg TARGETARCH=amd64 -t cloakhub:mac-preview .
docker tag cloakhub:mac-preview cloakhub:mac-private
docker compose -f compose.yml -f compose.mac.yml up -d
```

Use `TARGETARCH=arm64` when building natively on ARM64. With Buildx,
`TARGETARCH` is supplied automatically for the selected platform. The Compose
override selects the local tag; the ordinary Compose file pins published version
`0.7.0`.

The repository contains 46 real-font files totaling 57,735,740 bytes (55.06 MiB),
from the earlier Apple catalog/recovery experiment, not a direct MacBook export.
See [font inventory](../fonts/README.md). No browser binary or license key is
embedded; the signed browser downloader installs the pinned browser into the
persistent data volume at startup.

Fonts live at `/opt/cloakhub/fonts/macos` in the image. The build checks all 20
required families and fails if any are missing. This verifies discoverability,
not complete glyph coverage, every font weight, or exact correspondence with a
modern Mac. For example, Comic Sans MS currently includes only Bold; the tested
Menlo and Comic Sans MS faces also remain unavailable through CSS `local()` in
both engines despite fontconfig finding them. See the
[151/152 comparison](browser-channel-comparison.md).

`CLOAKHUB_MACOS_FONTCONFIG_FILE=/app/macos-fonts.conf` adds those fonts only for
Mac browser processes. Linux and Windows profiles use ordinary font configuration.
`CLOAKHUB_DEFAULT_PLATFORM=macos` controls new-profile defaults in the image;
explicit and saved settings take precedence. Running the application outside
Docker retains its Linux default unless this variable is set.

Existing profiles and seeds are retained. Added fonts can change the rendered
fingerprint of existing Mac profiles. The display remains 1366×768. Public
detector results do not guarantee that every site will behave identically.

For a custom font directory, the optional `scripts/build-mac-image.sh FONT_DIR`
and `Dockerfile.mac` workflow remains available.

The browser version is pinned for repeatable builds. `CLOAKHUB_BROWSER_CHANNEL`
defaults to `preview`; to run the stable comparison, add these entries to the
Compose service’s `environment` (or pass them with `docker run -e`):

```yaml
CLOAKHUB_BROWSER_CHANNEL: stable
CLOAKHUB_BROWSER_VERSION: 151.0.7922.108.6
```

An entry in `.env` alone is insufficient unless Compose references it. Both the
channel and exact version are passed to the official verified downloader. A returned version that differs
from the pin is rejected. Future preview releases require an explicit pin update.
