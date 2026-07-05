# HTTP bind defaults and reverse proxy TLS

CloakHub will not terminate TLS itself in v1; operators should use a reverse proxy for HTTPS, and CloakHub should respect forwarded host/proto headers when generating external URLs. The non-Docker default bind address is `127.0.0.1`, configurable with `CLOAKHUB_HOST`, and the default port is `7788`, configurable with `CLOAKHUB_PORT`; Docker deployments may set the host to `0.0.0.0` inside the container.
