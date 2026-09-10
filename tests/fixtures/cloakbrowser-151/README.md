# Signed download manifest fixture

Unmodified official manifest and detached Ed25519 signature fetched on 2026-09-09 from:

- https://cloakbrowser.dev/releases/pro/chromium-v151.0.7922.108.4/SHA256SUMS
- https://cloakbrowser.dev/releases/pro/chromium-v151.0.7922.108.4/SHA256SUMS.sig

These public fixtures contain no license credentials. Tests verify them against the pinned
public keys in cloakbrowser 0.5.10, then test corrupted signatures, version binding, and
archive checksum rejection under Bun without network access.
