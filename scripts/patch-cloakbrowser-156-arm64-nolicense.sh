#!/usr/bin/env bash
# Remove the native LicenseRuntime phone-home from CloakBrowser 156.0.8078.47.1
# (Linux arm64) while preserving the fingerprint-table anti-detection path.
#
# arm64 counterpart of scripts/patch-cloakbrowser-156-nolicense.sh. The
# embedded kFingerprintTableCiphertext is byte-identical between the x64 and
# arm64 builds of this version (nonce 4fd1c6acd0a4ec4b97f536a1, size 0x2e17f8),
# so the x64 32-byte fingerprint-table key decrypts the arm64 table as well.
#
# Three edits are applied to the `chrome` binary (file_offset = vaddr - 0x10000):
#
#   A) ungoogled::LicenseRuntime::Start (vaddr 0xbf036f4) -> always early-return.
#      The arm64 gate is `ldrb w8,[x0,#0x122]; tbz w8,#0,<license flow>` at
#      0xbf03724. NOPing the `tbz` makes Start treat the runtime as already
#      started and fall through to the arg-releasing return, so no
#      /api/license/session/{start,heartbeat,end} request is ever made.
#
#   B) ungoogled::LicenseRuntime::BlockUntilFingerprintTableKeyResolved
#      (vaddr 0xbf02f28) -> install the baked-in 32-byte fingerprint-table key
#      via ungoogled::SetFingerprintTableKey (vaddr 0xbeffa34) and return,
#      avoiding the upstream wait. The key is parked in the now-dead
#      function body at 0xbf02f38.
#
#   C) renderer_preferences_util::UpdateFromSystemSettings (vaddr 0x7974c98)
#      -> feed the baked-in key into RendererPreferences.fingerprint_table_key
#      (offset 0x1f0). The original code loads the key span from
#      LicenseRuntime::GetInstance()+0xb0; we redirect that load at 0x7974d08
#      to the baked-in key using PC-relative ADRP/ADD (PIE/ASLR safe).
#
# Usage:
#   scripts/patch-cloakbrowser-156-arm64-nolicense.sh <src-binary> <out-dir>
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
OUT="${2:?usage: $0 <out-dir> must exist}"

if [ ! -f "$SRC" ]; then
  echo "error: not a file: $SRC" >&2
  exit 1
fi
if [ ! -d "$OUT" ]; then
  echo "error: output dir does not exist: $OUT" >&2
  exit 1
fi

# Validate the entire input before creating or overwriting an output.
EXPECTED_SHA256=7c50c3274a1aa7fef9f3399f4609b56ba5c5e34e1455f03782145289fda87082
ACTUAL_SHA256="$(sha256sum "$SRC" | cut -d ' ' -f 1)"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "error: unexpected input SHA-256: $ACTUAL_SHA256" >&2
  exit 1
fi
if [ "$(realpath "$SRC")" = "$(realpath -m "$OUT/chrome")" ]; then
  echo "error: source and output must differ" >&2
  exit 1
fi
cp --reflink=auto "$SRC" "$OUT/chrome"
chmod +x "$OUT/chrome"

# --- known offsets for chromium-156.0.8078.47.1 linux/arm64 ---
# Executable segment: file_offset = vaddr - 0x10000.
python3 - "$OUT/chrome" <<'PY'
import struct
import sys

path = sys.argv[1]

# 32-byte fingerprint-table key captured from a live x64 156.0.8078.47.1
# session (breakpoint on ungoogled::SetFingerprintTableKey). The embedded
# kFingerprintTableCiphertext is identical in the arm64 build, so this key
# decrypts it too.
KEY = bytes.fromhex(
    "568df9a8a8e0f68055f4d7819926537d"
    "133516963be6ab620dcb1cbd9a10de0e"
)

TEXT_DELTA = 0x10000

START_TBZ_VADDR = 0xBF03724        # tbz w8, #0, <license flow>
BLOCKENTRY_VADDR = 0xBF02F28       # BlockUntilFingerprintTableKeyResolved entry
KEY_VADDR = 0xBF02F38              # dead body of the same function, 8B-aligned
SETKEY_VADDR = 0xBEFFA34           # ungoogled::SetFingerprintTableKey
UPDATE_VADDR = 0x7974D08           # UpdateFromSystemSettings span load (adrp/add)


def off(vaddr):
    return vaddr - TEXT_DELTA


def adrp(rd, target, pc):
    """Encode ADRP Rd, <target> (both page-aligned relative to pc)."""
    diff = (target & ~0xFFF) - (pc & ~0xFFF)
    imm = diff >> 12
    assert -(1 << 20) <= imm < (1 << 20), hex(imm)
    immlo = imm & 0x3
    immhi = (imm >> 2) & 0x7FFFF
    return 0x90000000 | (immlo << 29) | (immhi << 5) | rd


def add_imm(rd, rn, imm):
    assert 0 <= imm < (1 << 12)
    return 0x91000000 | (imm << 10) | (rn << 5) | rd


def movz(rd, imm):
    assert 0 <= imm < (1 << 16)
    return 0x52800000 | (imm << 5) | rd


def b(target, pc):
    diff = target - pc
    assert diff % 4 == 0 and -(1 << 27) <= diff < (1 << 27)
    return 0x14000000 | ((diff >> 2) & 0x3FFFFFF)


NOP = 0xD503201F


def pack(*words):
    return b"".join(struct.pack("<I", w) for w in words)


with open(path, "r+b") as f:
    def read(vaddr, n):
        f.seek(off(vaddr))
        return f.read(n)

    def write(vaddr, data):
        f.seek(off(vaddr))
        f.write(data)

    # --- sanity: refuse to patch an unexpected build ---
    if read(START_TBZ_VADDR, 4) != struct.pack("<I", 0x36000328):
        raise SystemExit(
            f"unexpected bytes at Start tbz {START_TBZ_VADDR:#x}; "
            "is this the arm64 156.0.8078.47.1 build?"
        )
    if read(BLOCKENTRY_VADDR, 16) != pack(0xD503233F, 0xD10343FF, 0x39438008, 0xA90B7BFD):
        raise SystemExit(
            f"unexpected bytes at BlockUntil entry {BLOCKENTRY_VADDR:#x}; refusing to patch"
        )
    if read(UPDATE_VADDR, 20) != pack(
        adrp(8, 0x1244F000, UPDATE_VADDR), add_imm(8, 8, 0xE90),
        0x9107C260, 0xA9400D01, 0x8B030022
    ):
        raise SystemExit(
            f"unexpected bytes in UpdateFromSystemSettings {UPDATE_VADDR:#x}; refusing to patch"
        )

    # --- Patch A: Start early-return (NOP the tbz into the license flow) ---
    write(START_TBZ_VADDR, struct.pack("<I", NOP))

    # --- Patch B: install baked-in key from BlockUntil entry, then tail-call ---
    stub = pack(
        adrp(0, KEY_VADDR & ~0xFFF, BLOCKENTRY_VADDR),
        add_imm(0, 0, KEY_VADDR & 0xFFF),
        movz(1, 0x20),
        b(SETKEY_VADDR, BLOCKENTRY_VADDR + 12),
    )
    assert len(stub) == 16
    write(BLOCKENTRY_VADDR, stub)
    write(KEY_VADDR, KEY)

    # --- Patch C: renderer preferences use the baked-in key ---
    # Compute the relocated key address directly; never store an absolute VA.
    patch = pack(
        adrp(1, KEY_VADDR, UPDATE_VADDR),
        add_imm(1, 1, KEY_VADDR & 0xFFF),
        movz(3, 0x20),
        add_imm(0, 19, 0x1F0),
        0x8B030022,                    # add x2, x1, x3
    )
    write(UPDATE_VADDR, patch)

# verify
with open(path, "rb") as f:
    f.seek(off(START_TBZ_VADDR))
    assert f.read(4) == struct.pack("<I", NOP)
    f.seek(off(BLOCKENTRY_VADDR))
    assert f.read(16) == stub
    f.seek(off(KEY_VADDR))
    assert f.read(32) == KEY
    f.seek(off(UPDATE_VADDR))
    assert f.read(20) == patch

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
