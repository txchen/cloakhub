#!/usr/bin/env bash
# Remove the native LicenseRuntime phone-home from CloakBrowser 154.0.8037.57.1
# (Linux arm64) while preserving the fingerprint-table anti-detection path.
#
# arm64 counterpart of the x64 script (git history:
# scripts/patch-cloakbrowser-154-nolicense.sh). The embedded
# kFingerprintTableCiphertext is byte-identical between the x64 and arm64
# builds of this version (sha256 7d3fb14bd07871a6e2ed7a433acd5382b2e202c4a...,
# 0x3d8b9 bytes), so the x64 32-byte fingerprint-table key decrypts the arm64
# table as well.
#
# Three edits are applied to the `chrome` binary (file_offset = vaddr - 0x10000):
#
#   A) ungoogled::LicenseRuntime::Start (vaddr 0xba95e70) -> always early-return.
#      The arm64 gate is `ldrb w8,[x0,#0x122]; tbz w8,#0,<license flow>` at
#      0xba95ea0. NOPing the `tbz` makes Start treat the runtime as already
#      started and fall through to the arg-releasing return, so no
#      /api/license/session/{start,heartbeat,end} request is ever made.
#
#   B) ungoogled::LicenseRuntime::BlockUntilFingerprintTableKeyResolved
#      (vaddr 0xba9571c) -> install the baked-in 32-byte fingerprint-table key
#      via ungoogled::SetFingerprintTableKey (vaddr 0xba933e0) and return,
#      avoiding the upstream 25s startup stall. The key is parked in the now
#      dead function body at 0xba95730.
#
#   C) renderer_preferences_util::UpdateFromSystemSettings (vaddr 0x7756784)
#      -> feed the baked-in key into RendererPreferences.fingerprint_table_key
#      (offset 0x1f0). The original code loads the key span from
#      LicenseRuntime::GetInstance()+0xb0; we overwrite the load (0x77567d8)
#      with adrp/add pointing at the baked-in key and drop the now-pointless
#      self-assign guard.
#
# Usage:
#   scripts/patch-cloakbrowser-154-arm64-nolicense.sh <src-binary> <out-dir>
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

mkdir -p "$OUT"
cp --reflink=auto "$SRC" "$OUT/chrome"
chmod +x "$OUT/chrome"

# --- known offsets for chromium-154.0.8037.57.1-pro linux/arm64 ---
# Executable segment: file_offset = vaddr - 0x10000.
python3 - "$OUT/chrome" <<'PY'
import struct
import sys

path = sys.argv[1]

# 32-byte fingerprint-table key captured from a live x64 session (breakpoint on
# ungoogled::SetFingerprintTableKey). The embedded kFingerprintTableCiphertext
# is identical in the arm64 build, so this key decrypts it too.
KEY = bytes.fromhex(
    "60b78d61591f480409f57dc407c0d0a3"
    "140960b0b4e17c8d1643f03c8e67b75a"
)

TEXT_DELTA = 0x10000

START_TBZ_VADDR = 0xBA95EA0        # tbz w8, #0, <license flow>
BLOCKENTRY_VADDR = 0xBA9571C       # BlockUntilFingerprintTableKeyResolved entry
KEY_VADDR = 0xBA95730              # dead body of the same function, 16B-aligned
SETKEY_VADDR = 0xBA933E0           # ungoogled::SetFingerprintTableKey
UPDATE_VADDR = 0x77567D8           # UpdateFromSystemSettings span load block


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
            "is this the arm64 154.0.8037.57.1 build?"
        )
    if read(BLOCKENTRY_VADDR, 16) != pack(0xD503233F, 0xD10383FF, 0x39438008, 0xA90B7BFD):
        raise SystemExit(
            f"unexpected bytes at BlockUntil entry {BLOCKENTRY_VADDR:#x}; refusing to patch"
        )
    if read(UPDATE_VADDR, 28) != pack(
        0xD0054828, 0x91316108, 0xEB08013F, 0x540000A0, 0xA9400D01, 0x9107C260, 0x8B030022
    ):
        raise SystemExit(
            f"unexpected bytes in UpdateFromSystemSettings {UPDATE_VADDR:#x}; refusing to patch"
        )

    # --- Patch A: Start early-return (NOP the tbz into the license flow) ---
    write(START_TBZ_VADDR, struct.pack("<I", NOP))

    # --- Patch B: install baked-in key from BlockUntil entry, then tail-call ---
    stub = pack(
        adrp(0, KEY_VADDR, BLOCKENTRY_VADDR),
        add_imm(0, 0, KEY_VADDR & 0xFFF),
        movz(1, 0x20),
        b(SETKEY_VADDR, BLOCKENTRY_VADDR + 12),
    )
    assert len(stub) == 16
    write(BLOCKENTRY_VADDR, stub)
    write(KEY_VADDR, KEY)

    # --- Patch C: renderer preferences use the baked-in key ---
    patch = pack(
        adrp(1, KEY_VADDR, UPDATE_VADDR),
        add_imm(1, 1, KEY_VADDR & 0xFFF),
        movz(3, 0x20),                    # size = 0x20
        0x8B010062,                        # add x2, x1, x3 (last = ptr + size)
        0x9107C260,                        # add x0, x19, #0x1f0 (dest, unchanged)
        NOP,
        NOP,
    )
    assert len(patch) == 28
    write(UPDATE_VADDR, patch)

# verify
with open(path, "rb") as f:
    f.seek(off(START_TBZ_VADDR))
    assert f.read(4) == struct.pack("<I", NOP)
    f.seek(off(BLOCKENTRY_VADDR))
    assert f.read(4) == struct.pack("<I", adrp(0, KEY_VADDR, BLOCKENTRY_VADDR))
    f.seek(off(KEY_VADDR))
    assert f.read(32) == KEY
    f.seek(off(UPDATE_VADDR))
    assert f.read(8) == pack(adrp(1, KEY_VADDR, UPDATE_VADDR), add_imm(1, 1, KEY_VADDR & 0xFFF))

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
