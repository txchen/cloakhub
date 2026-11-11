# Fixed internal port ranges and default capacity

> Since [ADR 0035](0035-xvfb-and-voxl-display-runtime.md) the live viewer is a voxl stream rather than VNC; this decision applies to viewer connections unchanged.

CloakHub v1 will use fixed internal loopback TCP ranges for per-instance CDP and VNC endpoints, plus display numbers, and validate `max_running_instances` against those ranges rather than exposing range configuration. The default `CLOAKHUB_MAX_RUNNING_INSTANCES` is 10.
