# Bun backend owns browser processes

Superseded by [ADR 0036](0036-go-hub-runtime.md): the Go Hub now launches and supervises these processes. Owning them directly, without the Python `cloakbrowser` package, still holds.

CloakHub will use a Bun backend to launch and supervise browser, display, VNC, and proxy processes directly, rather than depending on the Python `cloakbrowser` package as a backend runtime. This keeps the project stack simple and aligned with the desired Bun-first implementation, at the cost of taking direct responsibility for binary discovery, launch arguments, and process lifecycle management.
