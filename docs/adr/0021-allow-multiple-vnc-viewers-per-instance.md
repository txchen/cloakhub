# Allow multiple VNC viewers per instance

> Since [ADR 0035](0035-xvfb-and-voxl-display-runtime.md) the live viewer is a voxl stream rather than VNC; this decision applies to viewer connections unchanged.

CloakHub will allow multiple Manual Clients to view the same Browser Instance over VNC, with no coordination guarantee for simultaneous input. Viewer Presence is tracked and displayed separately from Manual Input, and only Manual Input resets the idle window.
