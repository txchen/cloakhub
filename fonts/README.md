# Bundled Mac fonts

`macos/` contains 46 real-font files (57,735,740 bytes / 55.06 MiB), obtained in
the earlier Apple Font3/Font7 catalog and macOS 15.4.1 recovery experiment. They
were not exported directly from a MacBook. The files are copied unchanged from
the locally validated font set; `SHA256SUMS` records their content hashes.

The standard Dockerfile copies these files into `/opt/cloakhub/fonts/macos` and
checks 20 required font families using `scripts/check-mac-fonts.ts`. Only Mac
browser processes receive the extra fontconfig directory. This set is not a
complete macOS font inventory. The fonts retain their original ownership and
licensing; inclusion here does not relicense them as application source code.

The family check does not require every weight. In this set, Comic Sans MS is
present only as Bold (`comicbd.ttf`); the regular face is absent. Menlo’s regular
face has the full name `Menlo Regular` (PostScript `Menlo-Regular`), so CSS
`local("Menlo")` is not an equivalent test of that face.

In the 151/152 Mac-persona comparison, CSS `local()` could not load either Menlo
or Comic Sans MS even with the full/PostScript names tested. The other 18 checked
family names loaded. This browser-level gap remains unresolved; fontconfig family
discoverability alone does not establish complete browser font support.
