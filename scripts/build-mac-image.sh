#!/usr/bin/env bash
set -euo pipefail

font_dir=${1:?Usage: scripts/build-mac-image.sh FONT_DIRECTORY [LOCAL_IMAGE_TAG]}
image_tag=${2:-cloakhub:mac-private}
if [[ ! -d "$font_dir" ]]; then
  echo "Font directory does not exist: $font_dir" >&2
  exit 1
fi
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/cloakhub-mac-build.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT

# A small, explicit context keeps credentials, profile data and research files out.
cp "$repo_root/Dockerfile.mac" "$stage/Dockerfile"
cp -R "$repo_root/src" "$stage/src"
cp "$repo_root/scripts/macos-fonts.conf" "$stage/macos-fonts.conf"
cp "$repo_root/scripts/check-mac-fonts.ts" "$stage/check-mac-fonts.ts"
mkdir "$stage/fonts"
cp -RL "$font_dir/." "$stage/fonts/"
docker build --tag "$image_tag" "$stage"
echo "Built local image: $image_tag"
