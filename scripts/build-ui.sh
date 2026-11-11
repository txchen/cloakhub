#!/bin/sh
# Bundles the operator UI (src/ui) into internal/web/dist, which the Go server
# embeds. ESBUILD selects the esbuild binary (default: the npm dev dependency).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
esbuild=${ESBUILD:-$root/node_modules/.bin/esbuild}
out=$root/internal/web/dist
mkdir -p "$out"
cd "$root"
"$esbuild" app=src/ui/client.ts viewer=src/ui/viewer.ts login=src/ui/login.ts \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --log-level=warning "--outdir=$out"
cp src/ui/styles.css "$out/app.css"
echo "UI bundles written to $out"
