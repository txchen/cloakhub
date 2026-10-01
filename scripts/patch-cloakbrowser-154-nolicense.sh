#!/usr/bin/env bash
# Remove the native LicenseRuntime phone-home from CloakBrowser 154.0.8037.57.1
# (Linux x64) while preserving the fingerprint-table anti-detection path.
#
# Background / analysis: docs/browser-license-removal-feasibility.md and the
# 152 script scripts/patch-cloakbrowser-license-preview.sh.
#
# Three edits are applied to the `chrome` binary:
#
#   A) ungoogled::LicenseRuntime::Start -> always early-return. The first branch
#      is `cmpb $0x0,0x122(%rdi); je <license flow>`, i.e. it runs the session
#      flow only while the "started" flag (0x122) is clear. NOPing the `je`
#      makes Start treat the runtime as already started and fall through to the
#      ref-releasing return, so no /api/license/session/{start,heartbeat,end}
#      request is ever made.
#
#   B) ungoogled::LicenseRuntime::BlockUntilFingerprintTableKeyResolved ->
#      install the baked-in fingerprint-table key and return immediately. The
#      upstream build normally blocks here (25s = 0x17d7840us) until the license
#      server returns the wrapped table key; with the phone-home removed it would
#      stall startup. We jump straight to SetFingerprintTableKey with the
#      constant 32-byte key.
#
#   C) renderer_preferences_util::UpdateFromSystemSettings -> fill the
#      RendererPreferences fingerprint-table-key field (offset 0x1f0) from the
#      baked-in key instead of LicenseRuntime::GetInstance()+0xb0. Renderers read
#      this field in blink::WebViewImpl::UpdateRendererPreferences and call
#      SetFingerprintTableKey locally, so the spoofed voice/GPU tables still
#      decrypt in every renderer.
#
# The baked-in key is the plaintext that successfully decrypts the static
# `kFingerprintTableCiphertext` blob through crypto::Aead (AES-CTR-HMAC-SHA256).
# It is constant for this build (the ciphertext is compile-time constant), so it
# can be replayed offline.
#
# Usage:
#   scripts/patch-cloakbrowser-154-nolicense.sh <src-binary> <out-dir>
#
# <out-dir> must already exist. The patched `chrome` is written there and the
# sibling resource files (icudtl.dat, *.pak, locales/, ...) are symlinked so the
# patched binary can run in place.
#
# This only disables the native runtime's session/start, heartbeat and
# session/end. Hub-level license calls (src/browser-license.ts) and
# installer/wrapper calls are NOT covered.
set -euo pipefail

SRC="${1:?usage: $0 <src-binary> <out-dir>}"
OUT="${2:?usage: $0 <src-binary> <out-dir>}"

if [ ! -f "$SRC" ]; then
  echo "error: not a file: $SRC" >&2
  exit 1
fi
if [ ! -d "$OUT" ]; then
  echo "error: output dir does not exist: $OUT" >&2
  exit 1
fi

mkdir -p "$OUT"
cp --reflink=auto "$SRC" "$OUT/chrome"
chmod +x "$OUT/chrome"

# --- known offsets for chromium-154.0.8037.57.1-pro ---
# For this ELF the executable segment maps file_offset = vaddr - 0x1000.
python3 - "$OUT/chrome" <<'PY'
import struct
import sys

path = sys.argv[1]
# 32-byte fingerprint-table key captured from a live session (breakpoint on
# ungoogled::SetFingerprintTableKey). Verified to decrypt the embedded
# kFingerprintTableCiphertext (table-load flag set).
KEY = bytes.fromhex(
    "60b78d61591f480409f57dc407c0d0a3"
    "140960b0b4e17c8d1643f03c8e67b75a"
)

START_JE_VADDR = 0xD8C14AE          # je d8c1537
BLOCKENTRY_VADDR = 0xD8C0BA0        # BlockUntilFingerprintTableKeyResolved entry
KEY_VADDR = 0xD8C0BC0              # unused tail of the same function
SETKEY_VADDR = 0xD8BE8E0           # ungoogled::SetFingerprintTableKey
UPDATE_VADDR = 0x8B0F452           # UpdateFromSystemSettings loads key ptr/size

TEXT_DELTA = 0x1000


def off(vaddr):
    return vaddr - TEXT_DELTA


with open(path, "r+b") as f:
    def read(vaddr, n):
        f.seek(off(vaddr))
        return f.read(n)

    def write(vaddr, data):
        f.seek(off(vaddr))
        f.write(data)

    # --- sanity: refuse to patch an unexpected build ---
    if read(BLOCKENTRY_VADDR, 1) != b"\x55":
        raise SystemExit(
            f"unexpected bytes at BlockUntil entry {BLOCKENTRY_VADDR:#x}; "
            "is this the 154.0.8037.57.1 build?"
        )
    if read(START_JE_VADDR, 6) != bytes.fromhex("0f8483000000"):
        raise SystemExit(
            f"unexpected bytes at Start je {START_JE_VADDR:#x}; refusing to patch"
        )
    if read(UPDATE_VADDR, 3) != b"\x48\x8b\x35":
        raise SystemExit(
            f"unexpected bytes in UpdateFromSystemSettings; refusing to patch"
        )

    # --- Patch A: Start early-return ---
    write(START_JE_VADDR, bytes.fromhex("909090909090"))

    # --- Patch B: install baked-in key from BlockUntil entry, then return ---
    stub = bytearray()
    stub += b"\x48\x8d\x3d" + struct.pack(
        "<i", KEY_VADDR - (BLOCKENTRY_VADDR + 7)
    )                                    # lea rdi, [rip+key]
    stub += b"\xbe" + struct.pack("<I", 0x20)   # mov esi, 0x20
    stub += b"\xe9" + struct.pack(
        "<i", SETKEY_VADDR - (BLOCKENTRY_VADDR + len(stub) + 5)
    )                                    # jmp SetFingerprintTableKey
    assert len(stub) == 17, len(stub)
    write(BLOCKENTRY_VADDR, bytes(stub))
    write(KEY_VADDR, KEY)

    # --- Patch C: renderer preferences use the baked-in key ---
    patch = bytearray()
    patch += b"\x48\x8d\x35" + struct.pack(
        "<i", KEY_VADDR - (UPDATE_VADDR + 7)
    )                                    # lea rsi, [rip+key]
    patch += b"\xb9" + struct.pack("<I", 0x20)  # mov ecx, 0x20
    patch += b"\x90\x90"                  # pad to original 7-byte mov
    assert len(patch) == 14, len(patch)
    write(UPDATE_VADDR, bytes(patch))

# verify
with open(path, "rb") as f:
    f.seek(off(START_JE_VADDR))
    assert f.read(6) == bytes.fromhex("909090909090")
    f.seek(off(BLOCKENTRY_VADDR))
    assert f.read(17)[0:3] == b"\x48\x8d\x3d"
    f.seek(off(KEY_VADDR))
    assert f.read(32) == KEY
    f.seek(off(UPDATE_VADDR))
    assert f.read(3) == b"\x48\x8d\x35"

print(f"patched {path}")
PY

# symlink sibling resources (skip chrome itself) if present
SRC_DIR="$(cd "$(dirname "$SRC")" && pwd)"
for f in "$SRC_DIR"/*; do
  b="$(basename "$f")"
  [ "$b" = "chrome" ] && continue
  [ -e "$OUT/$b" ] || ln -s "$(realpath "$f")" "$OUT/$b"
done

echo "=== hashes ==="
sha256sum "$SRC" "$OUT/chrome"
echo "done: $OUT/chrome"
