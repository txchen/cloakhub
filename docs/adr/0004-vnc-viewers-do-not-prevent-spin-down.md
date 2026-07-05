# VNC viewers do not prevent spin-down

CloakHub may spin down a Browser Instance and disconnect its VNC viewers when the idle window expires, even if a viewer websocket is still open. Viewing alone is not Instance Activity; only Manual Input resets the idle window, which prevents abandoned viewer tabs from keeping browser and VNC processes alive.
