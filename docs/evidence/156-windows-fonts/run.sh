#!/bin/sh
set -eu
for config in r1-system r1-added r1-only r2-only r2-added r2-system; do
  echo "FONT_ARM=$config"
  node /suite/tests/browser-evaluation/run.mjs --config "/opt/evaluation/windows-fonts/configs/$config.json" --output /results/windows-fonts/runs --plan detectors --external
  sleep 45
done
