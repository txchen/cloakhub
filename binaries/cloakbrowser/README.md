# Local CloakBrowser 156 Linux bundles

Official Stable **156.0.8078.47.1**, downloaded for both supported Linux CPU architectures.
These are official licensed binaries, not the historical license-free 152 build.
No license key or license cache is included; normal execution still requires the
appropriate upstream authorization.

```text
156.0.8078.47.1/
  linux-x64/chrome                 # complete extracted x64 bundle beside it
  linux-arm64/chrome               # complete extracted ARM64 bundle beside it
  cloakbrowser-linux-x64.tar.gz    # original official archive
  cloakbrowser-linux-arm64.tar.gz  # original official archive
  SHA256SUMS                      # upstream signed manifest (includes other OSes)
  SHA256SUMS.sig                   # detached Ed25519 signature
  artifacts.json                  # sizes, hashes, source and verification metadata
```

Keep each complete extracted directory, not just the `chrome` executable: resources,
shared libraries and locales are required. The two archives are approximately 206 MiB
and 194 MiB; archives plus extracted bundles occupy approximately 1.5 GiB.

## Verification

The official manifest's Ed25519 signature, declared version and both archive SHA-256
values were verified before extraction. ELF machine types were checked as x86-64
and AArch64. The x64 executable returned `CloakBrowser 156.0.8078.47.1` in the existing
Linux evaluation container. **The ARM64 binary has not been executed on this x64 host.**

Offline verification with Node and `tar`:

```sh
node binaries/cloakbrowser/verify.mjs
```

This checks the signed archives, then compares each extracted `chrome` against the
same executable streamed from its authenticated archive, and checks ELF architecture
and executable permission. It does not claim an ARM64 runtime or browser test pass.

## Repository and image handling

The binary payloads are local files in this repository working tree and are excluded
from Git by `.gitignore`. Only documentation, verification code, signed manifests
and download metadata are versioned; a fresh clone does not contain the binaries.
No LFS upload, release upload or production deployment was performed. Use an agreed
binary artifact store, release assets or Git LFS if versioned distribution is required,
and confirm upstream redistribution terms first.

The default Docker build context excludes this local bundle directory to avoid
accidentally shipping both architectures or uploading gigabytes with ordinary builds.
Explicitly opt in with a dedicated build context or adjust the ignore rule when
implementing a pinned-binary image. Production Dockerfiles and browser selection
remain unchanged.
