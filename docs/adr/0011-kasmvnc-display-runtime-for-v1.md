# KasmVNC display runtime for v1

CloakHub will use KasmVNC's `Xvnc` as the v1 display runtime, with one display runtime per running Browser Instance. CloakBrowser Manager has already proven this stack for live browser viewing, and CloakHub's main improvement is lifecycle efficiency rather than replacing VNC technology; the implementation should still isolate KasmVNC behind a display-runtime boundary so it can be replaced later.
