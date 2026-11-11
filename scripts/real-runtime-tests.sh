#!/bin/sh
# Runs the opt-in real-runtime integration tests (internal/integration) inside a
# CloakHub image, which provides CloakBrowser, Xvfb and voxl.
# Usage: scripts/real-runtime-tests.sh [IMAGE] [go test flags...]
set -eu
image=${1:-cloakhub:local}
[ $# -gt 0 ] && shift
root=$(cd "$(dirname "$0")/.." && pwd)
binary=$(mktemp -d)/integration.test
trap 'rm -rf "$(dirname "$binary")"' EXIT
cd "$root"
CGO_ENABLED=0 go test -c -o "$binary" ./internal/integration
docker run --rm --shm-size 1g -v "$binary:/integration.test:ro" \
  -e CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true --entrypoint /integration.test "$image" -test.v "$@"
