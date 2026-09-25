#!/usr/bin/env bash
# Remove the native LicenseRuntime phone-home from the CloakBrowser preview
# build `152.0.7977.82.1` (Linux x64) by turning `ungoogled::LicenseRuntime::Start`
# into a no-op early return.
#
# Background / analysis: docs/browser-license-removal-feasibility.md
#
# Usage:
#   scripts/patch-cloakbrowser-license-preview.sh <src-binary> <out-dir>
#
# <out-dir> must already exist. The patched `chrome` is written there. If <src-binary>
# sits in a full browser directory, symlink the sibling resource files into <out-dir>
# (icudtl.dat, *.pak, locales/, etc.) so the patched binary can run in place.
#
# This only disables the native runtime's session/start, heartbeat and session/end.
# Hub-level license calls (src/browser-license.ts) and installer/wrapper calls are
# NOT covered. See the report.
set -euo pipefail

SRC="${1:?usage: $0 <src-binary> <out-dir>}"
OUT="${2:?usage: $0 <src-binary> <out-dir>}"

# --- known offsets for chromium-152.0.7977.82.1-pro ---
# LicenseRuntime::Start executes at vaddr 0xcfe19de. The .text section has
# file_offset = vaddr - 0x1000 for this binary.
OFF=$((0xcfe09de))
ORIG_HEX=0f8483000000 # je cfe1a67 (only taken when 0xb1 == 0)
NEW_HEX=909090909090    # NOP => always fall through to the ref-releasing return

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

python3 - "$OUT/chrome" "$OFF" "$ORIG_HEX" "$NEW_HEX" <<'PY'
import sys
path, off, orig_hex, new_hex = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
orig, new = bytes.fromhex(orig_hex), bytes.fromhex(new_hex)
with open(path, "r+b") as f:
    f.seek(off)
    cur = f.read(len(orig))
    if cur != orig:
        raise SystemExit(f"unexpected bytes at file offset {off:#x}: {cur.hex()} (expected {orig.hex()}); refusing to patch")
    f.seek(off)
    f.write(new)

with open(path, "rb") as f:
    f.seek(off)
    assert f.read(len(new)) == new
print(f"patched {path} at offset {off:#x}")
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
