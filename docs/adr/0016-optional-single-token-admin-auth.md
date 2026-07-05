# Optional single-token admin auth

CloakHub v1 will support optional single-token admin authentication through `CLOAKHUB_AUTH_TOKEN` for the UI and admin APIs. This is not a multi-user permission model; CDP access is governed separately by per-profile CDP Tokens. Operators exposing CloakHub beyond localhost should use HTTPS at a reverse proxy.
