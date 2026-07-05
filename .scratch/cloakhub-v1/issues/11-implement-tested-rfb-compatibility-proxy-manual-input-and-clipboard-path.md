# Implement tested RFB compatibility proxy, Manual Input, and clipboard path

Status: ready-for-agent

## What to build

Implement the RFB compatibility proxy between noVNC clients and KasmVNC. The proxy should handle required message filtering/rewriting and clipboard translation, infer Manual Input from client-to-server RFB traffic, throttle activity updates, and allow multiple Manual Clients while making Viewer Presence and last Manual Input visible.

## Acceptance criteria

- [ ] noVNC clients connect through CloakHub's RFB compatibility proxy rather than a blind websocket relay.
- [ ] The proxy handles the required RFB filtering/rewriting and clipboard translation inherited from the reference design.
- [ ] Manual Input is inferred on the backend from client-to-server RFB messages, including keyboard, pointer, wheel, and clipboard paste.
- [ ] Pointer movement counts as Manual Input, with activity updates throttled to avoid excessive writes.
- [ ] Viewer Presence does not by itself prevent Spin-down; Manual Input updates Instance Activity.
- [ ] Multiple VNC viewers can connect to the same Browser Instance and are reflected in status.
- [ ] Tests cover RFB parsing/filtering/rewriting, clipboard translation, Manual Input detection, throttling, multiple viewers, and viewer-only Spin-down behavior.

## Blocked by

- [10-launch-headed-browser-instances-and-open-manual-novnc-viewer.md](./10-launch-headed-browser-instances-and-open-manual-novnc-viewer.md)
