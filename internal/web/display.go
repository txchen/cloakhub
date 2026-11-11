package web

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/txchen/cloakhub/internal/browser"
)

// voxl page assets the viewer iframe loads through CloakHub.
var displayAssets = map[string]bool{
	"": true, "index.html": true, "client.js": true, "worker.js": true, "audio.js": true,
	"mic.js": true, "favicon.ico": true, "inter.woff2": true,
}

var displayPath = regexp.MustCompile(`^/ui/profiles/([^/]+)/display/([^/]*)$`)

func (s *Server) displayRoute(w http.ResponseWriter, r *http.Request, path string) (*response, bool) {
	match := displayPath.FindStringSubmatch(path)
	if match == nil {
		return nil, false
	}
	if s.runtime == nil {
		return textResponse("Not found", 404, nil), true
	}
	profileID, asset := match[1], match[2]
	if asset == "ws" {
		if !isWebSocketUpgrade(r) {
			return textResponse("Viewer websocket upgrade is required", 426, nil), true
		}
		state, err := s.runtime.OpenManualViewer(profileID)
		if err != nil {
			return viewerJSONError(err), true
		}
		s.serveDisplayStream(w, r, state)
		return nil, true
	}
	if !displayAssets[asset] {
		return textResponse("Not found", 404, nil), true
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return methodNotAllowed("GET, HEAD"), true
	}
	state, err := s.runtime.OpenManualViewer(profileID)
	if err != nil {
		return viewerJSONError(err), true
	}
	client := http.Client{Timeout: 10 * time.Second}
	request, _ := http.NewRequest(r.Method, "http://127.0.0.1:"+strconv.Itoa(state.ViewerPort)+"/"+asset, nil)
	upstream, err := client.Do(request)
	if err != nil {
		return viewerJSONError(err), true
	}
	defer upstream.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(upstream.Body, 16<<20))
	result := newResponse(upstream.StatusCode, "", body, map[string]string{"X-Content-Type-Options": "nosniff"})
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag", "Last-Modified"} {
		if value := upstream.Header.Get(name); value != "" {
			result.header.Set(name, value)
		}
	}
	return result, true
}

// voxl wire protocol (web/src/protocol.ts upstream): binary messages start with a
// type byte; client text messages are short comma-separated commands; server text
// messages are JSON objects with a "t" field.
const (
	binServerClipImage = 0x04
	binClientClipImage = 0x11
	binClientMicOpus   = 0x12
	binClientMicPCM    = 0x13
)

var (
	manualInputCommands = map[string]bool{"m": true, "b": true, "sp": true, "k": true, "c": true}
	// Microphone and dynamic resolution are never used by the viewer.
	blockedCommands = map[string]bool{"mi": true, "sz": true}
)

// classifyClientMessage decides whether to forward a viewer message and whether it
// is Manual Input.
func classifyClientMessage(messageType int, data []byte, clipboardSync bool) (forward, manualInput bool) {
	if messageType == websocket.TextMessage {
		command, _, _ := strings.Cut(string(data), ",")
		if blockedCommands[command] || (command == "c" && !clipboardSync) {
			return false, false
		}
		return true, manualInputCommands[command]
	}
	if len(data) == 0 {
		return true, false
	}
	switch data[0] {
	case binClientMicOpus, binClientMicPCM:
		return false, false
	case binClientClipImage:
		return clipboardSync, clipboardSync
	}
	return true, false
}

// forwardServerMessage drops desktop clipboard data when clipboard sync is off.
func forwardServerMessage(messageType int, data []byte, clipboardSync bool) bool {
	if clipboardSync {
		return true
	}
	if messageType == websocket.TextMessage {
		if !strings.Contains(string(data), `"clip"`) {
			return true
		}
		var message struct {
			T string `json:"t"`
		}
		if json.Unmarshal(data, &message) != nil {
			return false
		}
		return message.T != "clip"
	}
	return len(data) == 0 || data[0] != binServerClipImage
}

var displayUpgrader = websocket.Upgrader{
	ReadBufferSize:  16 * 1024,
	WriteBufferSize: 64 * 1024,
	// The route requires the UI cookie; voxl's page is same-origin.
	CheckOrigin: func(*http.Request) bool { return true },
}

// serveDisplayStream relays a viewer WebSocket to the instance's private voxl
// server, recording Manual Input and enforcing the clipboard preference.
func (s *Server) serveDisplayStream(w http.ResponseWriter, r *http.Request, state browser.ViewerState) {
	session, err := s.runtime.OpenViewerSession(state.ProfileID)
	if err != nil {
		viewerJSONError(err).write(w, false)
		return
	}
	defer session.Close()
	clientConn, err := displayUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer clientConn.Close()
	clientConn.SetReadLimit(64 << 20)
	// No Origin header: voxl treats non-browser clients on loopback as trusted.
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 64 * 1024, WriteBufferSize: 16 * 1024}
	upstream, _, err := dialer.Dial("ws://127.0.0.1:"+strconv.Itoa(state.ViewerPort)+"/ws", nil)
	if err != nil {
		_ = clientConn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "Viewer stream proxy error"), time.Now().Add(time.Second))
		return
	}
	defer upstream.Close()
	upstream.SetReadLimit(64 << 20)
	// The preference can change while a viewer is open; re-read it at most once a second.
	var cacheMu sync.Mutex
	cachedAt, cached := time.Time{}, state.ClipboardSync
	clipboardSync := func() bool {
		if s.profiles == nil {
			return true
		}
		cacheMu.Lock()
		defer cacheMu.Unlock()
		if time.Since(cachedAt) > time.Second {
			p := s.profiles.Get(state.ProfileID)
			cached, cachedAt = p != nil && p.ClipboardSync, time.Now()
		}
		return cached
	}
	var clientWrite sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			messageType, data, err := upstream.ReadMessage()
			if err != nil {
				clientWrite.Lock()
				_ = clientConn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
				clientWrite.Unlock()
				_ = clientConn.Close()
				return
			}
			if !forwardServerMessage(messageType, data, clipboardSync()) {
				continue
			}
			clientWrite.Lock()
			_ = clientConn.SetWriteDeadline(time.Now().Add(15 * time.Second))
			err = clientConn.WriteMessage(messageType, data)
			clientWrite.Unlock()
			if err != nil {
				// A dropped H.264 frame corrupts the stream until the next keyframe, so
				// close and let the viewer reconnect cleanly.
				_ = clientConn.Close()
				return
			}
		}
	}()
	for {
		messageType, data, err := clientConn.ReadMessage()
		if err != nil {
			break
		}
		forward, manualInput := classifyClientMessage(messageType, data, clipboardSync())
		if manualInput {
			session.RecordInput()
		}
		if forward {
			if err := upstream.WriteMessage(messageType, data); err != nil {
				break
			}
		}
	}
	_ = upstream.Close()
	<-done
}
