# Asymmetric CDP and VNC idle activity

> Since [ADR 0035](0035-xvfb-and-voxl-display-runtime.md) the live viewer is a voxl stream rather than VNC; this decision applies to viewer connections unchanged.

CloakHub treats an open CDP websocket as Instance Activity, but does not treat an open VNC viewer websocket as activity unless the viewer sends Manual Input. This protects automation controllers that keep a CDP session open between commands, while preventing forgotten browser-viewer tabs from keeping Browser Instances alive indefinitely.
