# Tested RFB compatibility proxy

CloakHub will include a tested RFB compatibility proxy between noVNC clients and KasmVNC instead of relying on a blind websocket relay. CloakBrowser Manager needed message filtering, encoding rewriting, pointer-event rewriting, and clipboard translation for this stack; CloakHub should isolate that logic in a focused module with tests so VNC behavior can evolve safely.
