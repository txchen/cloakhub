package cdp

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/profile"
)

type fakeRuntime struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (r *fakeRuntime) Start(id string) (browser.State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, "start:"+id)
	if r.err != nil {
		return browser.State{}, r.err
	}
	return browser.State{CdpPort: 5100, ProfileID: id, Status: "running"}, nil
}

func (r *fakeRuntime) RecordCdpDiscovery(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, "discovery:"+id)
	return nil
}

type fakeProfiles map[string]string

func (p fakeProfiles) Get(id string) *profile.Profile {
	token, ok := p[id]
	if !ok {
		return nil
	}
	result := &profile.Profile{ProfileID: id}
	if token != "" {
		result.CdpToken = &token
	}
	return result
}

func decode(t *testing.T, raw string) any {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func request(target string, header map[string]string) *http.Request {
	r := httptest.NewRequest("GET", target, nil)
	for k, v := range header {
		r.Header.Set(k, v)
	}
	return r
}

func TestDiscoveryWakesAndRewritesURLs(t *testing.T) {
	runtime := &fakeRuntime{}
	var paths []string
	gateway := &Gateway{Runtime: runtime, GetJSON: func(port int, path string) (any, error) {
		paths = append(paths, path)
		if path == "/json" {
			return decode(t, `[{"id":"page-1","type":"page","webSocketDebuggerUrl":"ws://127.0.0.1:5100/devtools/page/page-1",
				"devtoolsFrontendUrl":"/devtools/inspector.html?ws=127.0.0.1:5100/devtools/page/page-1"}]`), nil
		}
		return decode(t, `{"Browser":"CloakBrowser","webSocketDebuggerUrl":"ws://127.0.0.1:5100/devtools/browser/browser-1"}`), nil
	}}
	public, _ := url.Parse("https://hub.example/api/profiles/work/cdp/json/version")
	result, err := gateway.Discovery(request(public.String(), nil), public, "work", "/json/version")
	if err != nil {
		t.Fatal(err)
	}
	if got := result.(map[string]any)["webSocketDebuggerUrl"]; got != "wss://hub.example/api/profiles/work/cdp/devtools/browser/browser-1" {
		t.Errorf("rewrite %v", got)
	}
	if strings.Join(runtime.calls, ",") != "start:work,discovery:work" || paths[0] != "/json/version" {
		t.Errorf("calls %v paths %v", runtime.calls, paths)
	}

	plain, _ := url.Parse("http://cloakhub.test/api/profiles/work/cdp/json/list?token=profile-token")
	list, err := gateway.Discovery(request(plain.String(), nil), plain, "work", "/json/list")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(list)
	body := string(encoded)
	if !strings.Contains(body, "ws://cloakhub.test/api/profiles/work/cdp/devtools/page/page-1?token=profile-token") ||
		strings.Contains(body, "5100") || strings.Contains(body, "127.0.0.1") || paths[1] != "/json" {
		t.Errorf("list %s paths %v", body, paths)
	}
}

func TestAuthorizationRunsBeforeRecoveryAndScopesTokens(t *testing.T) {
	runtime := &fakeRuntime{}
	gateway := &Gateway{Runtime: runtime, Profiles: fakeProfiles{"work": "secret", "open": "", "other": "other-token"},
		GetJSON: func(int, string) (any, error) { return map[string]any{}, nil }}
	public, _ := url.Parse("http://hub/api/profiles/work/cdp")
	if _, err := gateway.Discovery(request("http://hub/x", nil), public, "work", "/json/version"); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("missing token: %v", err)
	}
	if len(runtime.calls) != 0 {
		t.Error("woke the profile before authorizing")
	}
	for _, r := range []*http.Request{
		request("http://hub/x", map[string]string{"Authorization": "Bearer secret"}),
		request("http://hub/x", map[string]string{"Authorization": "bearer secret"}),
		request("http://hub/x?token=secret", nil),
	} {
		if !gateway.Authorize(r, "work") {
			t.Errorf("rejected %v", r.URL)
		}
	}
	if gateway.Authorize(request("http://hub/x?token=other-token", nil), "work") {
		t.Error("another profile's token was accepted")
	}
	if !gateway.Authorize(request("http://hub/x", nil), "open") {
		t.Error("open profile rejected")
	}
}

func TestDiscoveryRejectsHTTPCloseAndPropagatesRecoveryErrors(t *testing.T) {
	gateway := &Gateway{Runtime: &fakeRuntime{}}
	public, _ := url.Parse("http://hub/")
	if _, err := gateway.Discovery(request("http://hub/x", nil), public, "work", "/json/close/abc"); !errors.Is(err, ErrCloseOverHTTP) {
		t.Errorf("close: %v", err)
	}
	failing := &Gateway{Runtime: &fakeRuntime{err: &browser.CapacityError{}}}
	var capacity *browser.CapacityError
	if _, err := failing.Discovery(request("http://hub/x", nil), public, "work", "/json/version"); !errors.As(err, &capacity) {
		t.Errorf("capacity: %v", err)
	}
}

func TestWebSocketTargets(t *testing.T) {
	gateway := &Gateway{Runtime: &fakeRuntime{}, GetJSON: func(int, string) (any, error) {
		return decode(t, `{"webSocketDebuggerUrl":"ws://127.0.0.1:5100/devtools/browser/b1"}`), nil
	}}
	root, err := gateway.WebSocketTarget(request("http://hub/x", nil), "work", "/json/version")
	if err != nil || root.URL != "ws://127.0.0.1:5100/devtools/browser/b1" || root.BrowserURL != root.URL {
		t.Errorf("root %+v %v", root, err)
	}
	page, _ := gateway.WebSocketTarget(request("http://hub/x", nil), "work", "/devtools/page/p1")
	if page.URL != "ws://127.0.0.1:5100/devtools/page/p1" || page.BrowserURL != "ws://127.0.0.1:5100/devtools/browser/b1" {
		t.Errorf("page %+v", page)
	}
	id, path, ok, err := ParseRoute("/api/profiles/work/cdp")
	if !ok || err != nil || id != "work" || path != "/json/version" {
		t.Errorf("route %s %s", id, path)
	}
	if _, path, _, _ := ParseRoute("/api/profiles/work/cdp/devtools/page/x"); path != "/devtools/page/x" {
		t.Errorf("route path %s", path)
	}
	if _, _, ok, _ := ParseRoute("/api/profiles/work"); ok {
		t.Error("non-CDP route matched")
	}
}

// fakeBrowser is a CDP WebSocket endpoint with a target list.
type fakeBrowser struct {
	mu      sync.Mutex
	targets []TargetInfo
	calls   []string
	blank   int
	failNew bool
	server  *httptest.Server
	sockets int
}

func newFakeBrowser(targets ...TargetInfo) *fakeBrowser {
	b := &fakeBrowser{targets: targets}
	b.server = httptest.NewServer(http.HandlerFunc(b.serve))
	return b
}

func (b *fakeBrowser) url(path string) string {
	return "ws" + strings.TrimPrefix(b.server.URL, "http") + path
}

func (b *fakeBrowser) serve(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	b.mu.Lock()
	b.sockets++
	b.mu.Unlock()
	defer conn.Close()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var message struct {
			ID        int64          `json:"id"`
			Method    string         `json:"method"`
			SessionID string         `json:"sessionId"`
			Params    map[string]any `json:"params"`
		}
		json.Unmarshal(data, &message)
		reply := map[string]any{"id": message.ID}
		if message.SessionID != "" {
			reply["sessionId"] = message.SessionID
		}
		b.mu.Lock()
		switch message.Method {
		case "Target.getTargets":
			b.calls = append(b.calls, "getTargets")
			reply["result"] = map[string]any{"targetInfos": append([]TargetInfo{}, b.targets...)}
		case "Target.createTarget":
			b.calls = append(b.calls, "create:"+message.Params["url"].(string))
			if b.failNew {
				reply["error"] = map[string]any{"code": -1, "message": "nope"}
			} else {
				b.blank++
				id := "blank-" + itoa64(int64(b.blank))
				b.targets = append(b.targets, TargetInfo{TargetID: id, Type: "page"})
				reply["result"] = map[string]any{"targetId": id}
			}
		case "Target.closeTarget":
			id := message.Params["targetId"].(string)
			b.calls = append(b.calls, "close:"+id)
			kept := b.targets[:0]
			for _, t := range b.targets {
				if t.TargetID != id {
					kept = append(kept, t)
				}
			}
			b.targets = kept
			reply["result"] = map[string]any{"success": true}
		case "Echo":
			reply["result"] = map[string]any{"echo": true}
		case "Quit":
			b.mu.Unlock()
			return
		}
		b.mu.Unlock()
		encoded, _ := json.Marshal(reply)
		conn.WriteMessage(websocket.TextMessage, encoded)
	}
}

func TestTabGuardCreatesABlankBeforeTheLastPageCloses(t *testing.T) {
	b := newFakeBrowser(
		TargetInfo{TargetID: "page", Type: "page"},
		TargetInfo{TargetID: "worker", Type: "service_worker"},
		TargetInfo{TargetID: "pre", Type: "page", Subtype: "prerender"},
	)
	defer b.server.Close()
	blanks := 0
	guard := &TabGuard{OnBlankTab: func(string) { blanks++ }}
	reply, err := guard.Close("work", b.url("/devtools/browser/b"), "page", func() (Reply, error) {
		return Reply{Result: json.RawMessage(`{"success":true}`)}, nil
	})
	if err != nil || string(reply.Result) != `{"success":true}` {
		t.Fatalf("%+v %v", reply, err)
	}
	if strings.Join(b.calls, ",") != "getTargets,create:about:blank" || blanks != 1 {
		t.Errorf("calls %v blanks %d", b.calls, blanks)
	}
}

func TestTabGuardFailsClosedWhenBlankCreationFails(t *testing.T) {
	b := newFakeBrowser(TargetInfo{TargetID: "a", Type: "page"})
	defer b.server.Close()
	b.failNew = true
	guard := &TabGuard{}
	closed := false
	for range 2 {
		if _, err := guard.Close("work", b.url("/"), "a", func() (Reply, error) { closed = true; return Reply{}, nil }); err == nil {
			t.Error("expected failure")
		}
	}
	if closed {
		t.Error("close was forwarded without protection")
	}
}

func startRelay(t *testing.T, b *fakeBrowser, guard *TabGuard) (*httptest.Server, *fakeSessions) {
	sessions := &fakeSessions{}
	relay := &Relay{Sessions: sessions, Guard: guard}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := Target{ProfileID: "work", BrowserURL: b.url("/devtools/browser/b"), URL: b.url(r.URL.Path)}
		relay.Serve(w, r, target, "127.0.0.1")
	}))
	t.Cleanup(server.Close)
	return server, sessions
}

type fakeSessions struct {
	mu              sync.Mutex
	opened, closed  int
	messages        int
	userAgent, addr string
}

type fakeSession struct{ s *fakeSessions }

func (f fakeSession) Close() { f.s.mu.Lock(); f.s.closed++; f.s.mu.Unlock() }
func (f fakeSession) RecordMessage() {
	f.s.mu.Lock()
	f.s.messages++
	f.s.mu.Unlock()
}

func (s *fakeSessions) OpenCdpSession(profileID, remoteAddress, userAgent string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.opened++
	s.userAgent, s.addr = userAgent, remoteAddress
	return fakeSession{s}, nil
}

func dialRelay(t *testing.T, server *httptest.Server, path string) *websocket.Conn {
	header := http.Header{"User-Agent": {"relay-test"}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+path, header)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func roundTrip(t *testing.T, conn *websocket.Conn, message string) map[string]any {
	t.Helper()
	if err := conn.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	json.Unmarshal(data, &reply)
	return reply
}

func TestRelayForwardsAndProtectsClosesAcrossClients(t *testing.T) {
	b := newFakeBrowser(TargetInfo{TargetID: "a", Type: "page"}, TargetInfo{TargetID: "b", Type: "page"})
	defer b.server.Close()
	server, sessions := startRelay(t, b, &TabGuard{})
	first := dialRelay(t, server, "/devtools/browser/b")
	second := dialRelay(t, server, "/devtools/browser/b")
	defer first.Close()
	defer second.Close()

	if reply := roundTrip(t, first, `{"id":1,"method":"Echo"}`); reply["result"].(map[string]any)["echo"] != true {
		t.Errorf("echo %v", reply)
	}
	var wg sync.WaitGroup
	replies := make([]map[string]any, 2)
	for i, conn := range []*websocket.Conn{first, second} {
		wg.Add(1)
		go func(i int, conn *websocket.Conn, target string) {
			defer wg.Done()
			replies[i] = roundTrip(t, conn, `{"id":7,"method":"Target.closeTarget","params":{"targetId":"`+target+`"}}`)
		}(i, conn, []string{"a", "b"}[i])
	}
	wg.Wait()
	for _, reply := range replies {
		if reply["id"].(float64) != 7 || reply["result"].(map[string]any)["success"] != true {
			t.Errorf("close reply %v", reply)
		}
	}
	b.mu.Lock()
	remaining := len(b.targets)
	creates := strings.Count(strings.Join(b.calls, ","), "create:")
	b.mu.Unlock()
	if remaining != 1 || creates != 1 {
		t.Errorf("expected exactly one protective blank tab, targets=%d creates=%d calls=%v", remaining, creates, b.calls)
	}
	sessions.mu.Lock()
	if sessions.opened != 2 || sessions.userAgent != "relay-test" || sessions.messages < 3 {
		t.Errorf("sessions %+v", sessions)
	}
	sessions.mu.Unlock()
}

func TestRelayRejectsUnidentifiableClose(t *testing.T) {
	b := newFakeBrowser(TargetInfo{TargetID: "a", Type: "page"})
	defer b.server.Close()
	server, _ := startRelay(t, b, &TabGuard{})
	conn := dialRelay(t, server, "/devtools/browser/b")
	defer conn.Close()
	reply := roundTrip(t, conn, `{"id":3,"sessionId":"unknown","method":"Page.close"}`)
	if reply["error"].(map[string]any)["message"] != "Cannot identify the tab to close safely" || reply["sessionId"] != "unknown" {
		t.Errorf("reply %v", reply)
	}
}

func TestRelayClosesClientWhenBrowserGoesAway(t *testing.T) {
	b := newFakeBrowser()
	server, sessions := startRelay(t, b, &TabGuard{})
	conn := dialRelay(t, server, "/devtools/browser/b")
	defer conn.Close()
	roundTrip(t, conn, `{"id":1,"method":"Echo"}`)
	conn.WriteMessage(websocket.TextMessage, []byte(`{"id":2,"method":"Quit"}`))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Error("client stayed open")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sessions.mu.Lock()
		closed := sessions.closed
		sessions.mu.Unlock()
		if closed == 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("session not closed")
}
