# Fixed internal port ranges and default capacity

CloakHub v1 will use fixed internal loopback TCP ranges for per-instance CDP and VNC endpoints, plus display numbers, and validate `max_running_instances` against those ranges rather than exposing range configuration. The default `CLOAKHUB_MAX_RUNNING_INSTANCES` is 10.
