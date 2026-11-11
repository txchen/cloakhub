# Mac fonts and image builds

The published image (`ghcr.io/txchen/cloakhub`, built from the repository `Dockerfile`
for amd64 and arm64) includes the fonts in `fonts/macos/` and defaults new profiles to
a macOS identity. It bakes the license-free CloakBrowser build described in the
[README](../README.md#what-the-image-contains); nothing is downloaded at startup.

The repository contains 46 real-font files totaling 57,735,740 bytes (55.06 MiB),
from an earlier Apple catalog/recovery experiment, not a direct MacBook export.
See the [font inventory](../fonts/README.md).

Fonts live at `/opt/cloakhub/fonts/macos` in the image. The build runs
`scripts/check-mac-fonts.sh`, which checks all 20 required families and fails if any are
missing. This verifies discoverability, not complete glyph coverage, every font weight,
or exact correspondence with a modern Mac. For example, Comic Sans MS currently includes
only Bold, and Menlo and Comic Sans MS stayed unavailable through CSS `local()` in
earlier tests even though fontconfig finds them.

`CLOAKHUB_MACOS_FONTCONFIG_FILE=/app/macos-fonts.conf` adds those fonts only for Mac
browser processes. Linux and Windows profiles use ordinary font configuration.
`CLOAKHUB_DEFAULT_PLATFORM=macos` controls new-profile defaults in the image; explicit
and saved settings take precedence. Running the Hub from source keeps the Linux default
unless this variable is set.

Existing profiles and seeds are retained. Changing fonts can change the rendered
fingerprint of existing Mac profiles. Public detector results do not guarantee that
every site will behave identically.

## Build the image yourself

```sh
docker build -t cloakhub:local .
```

Buildx supplies `TARGETARCH` for the selected platform; a plain `docker build` builds
for the host architecture.

## Use your own font directory

To replace the bundled fonts with your own, build a private image on top of the
published one:

```sh
scripts/build-mac-image.sh /path/to/fonts            # tags cloakhub:mac-private
docker compose -f compose.yml -f compose.mac.yml up -d
```

`Dockerfile.mac` copies the directory to `/opt/cloakhub/fonts/macos`, refreshes the font
cache and runs the same family check. `compose.mac.yml` points the service at the local
`cloakhub:mac-private` tag. Set `BASE_IMAGE` in `Dockerfile.mac` to choose the base
release.
