#!/usr/bin/env bash
# Smoke-test a locally loaded image on its native architecture: pinned browser,
# offline concurrent launches, the viewer runtime, and Hub health.
set -euo pipefail
IMAGE="${1:?usage: $0 <image> <expected-chrome-sha256>}"
EXPECTED="${2:?expected chrome SHA-256 required}"
NAME="cloakhub-smoke-$$"
cleanup() { docker rm -fv "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --network none --shm-size=1g --tmpfs /data --entrypoint sh \
  -e EXPECTED="$EXPECTED" "$IMAGE" -ec '
  echo "$EXPECTED  /opt/cloakbrowser/chrome" | sha256sum -c -
  /opt/cloakbrowser/chrome --version | grep -F "156.0.8078.47.1"
  timeout 45 /opt/cloakbrowser/chrome --headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/profile1 --dump-dom about:blank >/tmp/1.html 2>/tmp/1.log & p1=$!
  timeout 45 /opt/cloakbrowser/chrome --headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/profile2 --dump-dom about:blank >/tmp/2.html 2>/tmp/2.log & p2=$!
  s1=0; s2=0
  wait "$p1" || s1=$?
  wait "$p2" || s2=$?
  cat /tmp/1.log /tmp/2.log
  test "$s1" = 0 && test "$s2" = 0
  grep -F "<html>" /tmp/1.html
  grep -F "<html>" /tmp/2.html
  voxl --version
  Xvfb :99 -screen 0 640x480x24 -nolisten tcp -shmem -extension GLX & xvfb=$!
  for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
  DISPLAY=:99 voxl --addr=127.0.0.1 --port=5999 --enable-basic-auth=false --audio-enabled=false & streamer=$!
  ok=0
  for i in $(seq 1 50); do
    if bun -e "const r = await fetch(\"http://127.0.0.1:5999/healthz\"); process.exit(r.ok ? 0 : 1)" 2>/dev/null; then ok=1; break; fi
    sleep 0.2
  done
  kill "$streamer" "$xvfb"
  test "$ok" = 1
  echo "viewer runtime ok"
'

docker run -d --name "$NAME" --network none --tmpfs /data "$IMAGE"
# Poll inside the network-isolated container; no host ports are exposed.
for attempt in $(seq 1 30); do
  if docker exec "$NAME" bun -e 'const r = await fetch("http://127.0.0.1:7788/api/health"); if (!r.ok) process.exit(1); console.log(await r.text());'; then
    docker logs "$NAME"
    exit 0
  fi
  sleep 1
done
docker logs "$NAME"
exit 1
