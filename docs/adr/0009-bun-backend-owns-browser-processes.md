# Bun backend owns browser processes

CloakHub will use a Bun backend to launch and supervise browser, display, VNC, and proxy processes directly, rather than depending on the Python `cloakbrowser` package as a backend runtime. This keeps the project stack simple and aligned with the desired Bun-first implementation, at the cost of taking direct responsibility for binary discovery, launch arguments, and process lifecycle management.
