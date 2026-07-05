# CloakHub

CloakHub is a Bun backend for managing persistent CloakBrowser profiles and on-demand browser runtimes.

## Run

```sh
bun install
bun run start
```

Startup requires a discoverable CloakBrowser Binary. Set `CLOAKHUB_BROWSER_BIN`, provide the packaged Docker path, or install `cloakbrowser` on `PATH`.

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
