# Capacity preemption for disconnected instances

> Since [ADR 0035](0035-xvfb-and-voxl-display-runtime.md) the live viewer is a voxl stream rather than VNC; this decision applies to viewer connections unchanged.

When the Running Instance Limit is reached, CloakHub may spin down the least-recently-active Browser Instance that has no active CDP Sessions and no Manual Input in the last 60 seconds, even if its normal idle timeout has not expired. Viewer-only VNC sessions may be disconnected under capacity pressure. CloakHub records the stop reason as capacity preemption.
