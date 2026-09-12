# Personal Mac-persona image

The local `cloakhub:mac-private` image uses CloakBrowser stable
`151.0.7922.108.6`, real fonts supplied from a local directory, and `macos` as
the default persona for **new** profiles. Existing stored personas, seeds and
browser data are retained. The standard image is built separately.

## Build and run

Supply a directory containing your Mac font files, including the required
families below. The build script stages only the application source, font
configuration and that directory; profile data and license keys are not included.

```sh
scripts/build-mac-image.sh /path/to/mac-fonts
docker compose -f compose.yml -f compose.mac.yml up -d
```

The first command builds locally, without pushing an image. The Compose override
selects the local image and disables pulling it. The existing Compose settings
for the license file, authentication, persistent data and region still apply.
An optional second argument selects a different local image tag; update the
override to match if you use it.

On the current development machine, the previously tested, real-font directory
is `.cloakhub/cloak152-mac-fonts/fonts/`: 46 files, 55.06 MiB. These were obtained
in the earlier Apple-font experiment, not exported directly from your MacBook.
The build takes a local copy, so you can replace this directory with your own
export and rebuild. No font binaries are committed to the repository or added
to the public Docker build/publishing workflow.

The base application image is `ghcr.io/txchen/cloakhub:0.6.1`. The private build
overlays the checked-out application source and fixes its browser version to
stable `.6`; it keeps the existing signed browser downloader and license-key
handling. No browser binary or key is embedded. Keep the data volume to reuse
the downloaded browser. If the upstream free tier later serves a different
stable, the existing exact-version guard will reject it instead of silently
upgrading profiles.

## Fonts and profile defaults

The build checks these 20 families through fontconfig and fails if any are missing:
Apple Color Emoji, Arial, Arial Narrow, Arial Unicode MS, Comic Sans MS, Courier,
Courier New, Georgia, Gill Sans, Helvetica, Helvetica Neue, Impact, Menlo,
Microsoft Sans Serif, Monaco, Tahoma, Times New Roman, Trebuchet MS, Webdings,
Wingdings. This verifies discoverability, not provenance or complete glyph coverage.

The font files live at `/opt/cloakhub/fonts/macos`, shared by all Mac profiles.
`CLOAKHUB_MACOS_FONTCONFIG_FILE=/app/macos-fonts.conf` applies that extra directory
only when launching a Mac profile. Linux/Windows profiles continue to use the
ordinary font configuration. The desktop viewer and Hub process also keep the
ordinary configuration.

`CLOAKHUB_DEFAULT_PLATFORM=macos` controls defaults advertised to the UI and used
by minimal profile-creation API requests. Explicit profile settings take
precedence. The supported default values are `linux`, `windows`, and `macos`;
without an override, the application retains its standard Linux default.

The private image keeps headed mode and the existing 1366×768 display settings.
Changing the default persona does not rewrite existing profiles or rotate seeds.
Font changes can still change the rendered fingerprint of existing Mac profiles.

This is a personal build using the supplied fonts, not a grant of font rights.
Use font sources appropriate to your own license; this workflow does not publish
or redistribute them automatically.

The [private-image validation](../refs/mac-private-image-validation-2026-09-11.md)
records the observed benefits and limits. Public detector results do not guarantee
that every profile or business site will behave identically.
