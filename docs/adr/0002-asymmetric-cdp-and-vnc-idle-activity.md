# Asymmetric CDP and VNC idle activity

CloakHub treats an open CDP websocket as Instance Activity, but does not treat an open VNC viewer websocket as activity unless the viewer sends Manual Input. This protects automation controllers that keep a CDP session open between commands, while preventing forgotten browser-viewer tabs from keeping Browser Instances alive indefinitely.
