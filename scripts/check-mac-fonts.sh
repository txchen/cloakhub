#!/bin/sh
# Checks that fontconfig can find the Mac font families a macOS persona expects.
# Discoverability only, not font provenance or glyph coverage.
set -eu
families=$(fc-list --format "%{family}\n" | tr "," "\n" | sed "s/^ *//; s/ *$//" | sort -u)
missing=""
count=0
for name in "Apple Color Emoji" "Arial" "Arial Narrow" "Arial Unicode MS" "Comic Sans MS" \
  "Courier" "Courier New" "Georgia" "Gill Sans" "Helvetica" "Helvetica Neue" \
  "Impact" "Menlo" "Microsoft Sans Serif" "Monaco" "Tahoma" "Times New Roman" \
  "Trebuchet MS" "Webdings" "Wingdings"; do
  count=$((count + 1))
  printf "%s\n" "$families" | grep -qxF "$name" || missing="$missing, $name"
done
if [ -n "$missing" ]; then
  echo "Mac font directory is incomplete. Missing: ${missing#, }" >&2
  exit 1
fi
echo "Mac font check: $count/$count required families found"
