# CloakHub

CloakHub is a Bun backend for managing persistent CloakBrowser profiles and on-demand browser runtimes.

## Run

```sh
bun install
bun run start
```

Startup requires a discoverable CloakBrowser Binary. Set `CLOAKHUB_BROWSER_BIN`, provide the packaged Docker path, or install `cloakbrowser` on `PATH`.
Headed Browser Profiles also require KasmVNC `Xvnc`; if it is missing, startup continues with a warning and headed launch/viewer actions fail until `Xvnc` is installed.

## Docker

Docker-first operation uses `/data` as the Data Root and exposes CloakHub on port `7788`:

```sh
docker pull ghcr.io/txchen/cloakhub:latest
docker run --rm \
  -p 127.0.0.1:7788:7788 \
  -v cloakhub-data:/data \
  ghcr.io/txchen/cloakhub:latest
```

Equivalent Docker Compose service:

```yaml
services:
  cloakhub:
    image: ghcr.io/txchen/cloakhub:latest
    environment:
      CLOAKHUB_DATA_DIR: /data
      CLOAKHUB_HOST: 0.0.0.0
      CLOAKHUB_PORT: "7788"
    ports:
      - "7788:7788"
    volumes:
      - ./data:/data
```

The container listens on `0.0.0.0:7788` internally. The published image includes the CloakBrowser Binary at `/opt/cloakbrowser/cloakbrowser` and KasmVNC for headed Browser Profiles.

## Configuration

Defaults:

- `CLOAKHUB_HOST`: `127.0.0.1`
- `CLOAKHUB_PORT`: `7788`
- `CLOAKHUB_DATA_DIR`: `~/.cloakhub/data`
- `CLOAKHUB_MAX_RUNNING_INSTANCES`: `10`

Optional settings:

- `CLOAKHUB_BROWSER_BIN`: path to the CloakBrowser Binary
- `CLOAKHUB_AUTH_TOKEN`: admin auth token for protected UI and admin APIs

Docker deployments should set `CLOAKHUB_HOST=0.0.0.0` and `CLOAKHUB_DATA_DIR=/data`.

The Data Root contains profile data and secrets. Treat it as sensitive storage.

## Tests

Normal tests do not launch real CloakBrowser or KasmVNC:

```sh
bun test
```

Real-runtime integration tests are opt-in and require CloakBrowser plus KasmVNC for headed coverage:

```sh
CLOAKHUB_BROWSER_BIN=/path/to/cloakbrowser bun run integration:real-runtime
```

Those integration tests exercise real headless launch, headed KasmVNC/noVNC startup, CDP Transparent Recovery, spin-down/recovery persistence, and explicit Stop overriding active clients.
