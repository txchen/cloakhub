# Configurable data root

CloakHub will use a configurable Data Root, supplied by `CLOAKHUB_DATA_DIR`, rather than hard-coding `/data`. If the variable is not specified, CloakHub defaults to `~/.cloakhub/data`; Docker deployments can set `CLOAKHUB_DATA_DIR=/data` so mounted volumes still work cleanly.
