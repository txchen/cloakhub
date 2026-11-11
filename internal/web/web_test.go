package web

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/cdp"
	"github.com/txchen/cloakhub/internal/config"
	"github.com/txchen/cloakhub/internal/events"
	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/profile"
	"github.com/txchen/cloakhub/internal/viewer"
)

type handle struct {
	once sync.Once
	done chan struct{}
}

func newHandle() *handle                { return &handle{done: make(chan struct{})} }
func (h *handle) stop()                 { h.once.Do(func() { close(h.done) }) }
func (h *handle) Close() error          { h.stop(); return nil }
func (h *handle) Kill() error           { h.stop(); return nil }
func (h *handle) Done() <-chan struct{} { return h.done }

type launcher struct{}

func (launcher) Launch(browser.LaunchCommand) (browser.ProcessHandle, error) { return newHandle(), nil }

type display struct{}

func (display) Start(browser.DisplayCommand) (browser.ProcessHandle, error) { return newHandle(), nil }

type clipboardWriter struct{ text string }

func (c *clipboardWriter) WriteText(_, text string) error { c.text = text; return nil }

type hub struct {
	t        *testing.T
	server   *httptest.Server
	runtime  *browser.Runtime
	profiles *profile.Service
	dataRoot string
	writer   *clipboardWriter
}

// freeViewerPort finds an unused port inside the internal viewer range so a fake
// voxl server can stand in for the instance's stream.
func freeViewerPort(t *testing.T) (net.Listener, int) {
	for port := config.ViewerPortRange.End; port >= config.ViewerPortRange.Start; port-- {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			return listener, port
		}
	}
	t.Skip("no free viewer port")
	return nil, 0
}

func newHub(t *testing.T, token string, configure func(*browser.Options)) *hub {
	t.Helper()
	dataRoot := t.TempDir()
	repo, err := profile.OpenRepository(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	repo.Migrate()
	t.Cleanup(func() { repo.Close() })
	eventLog, err := events.Open(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { eventLog.Close() })
	service, err := profile.NewService(profile.ServiceOptions{DataRoot: dataRoot, Repository: repo,
		CreationRegion: profile.Region{Timezone: "Asia/Tokyo", Locale: "ja-JP"}, CreationPlatform: "macos"})
	if err != nil {
		t.Fatal(err)
	}
	owned := procs.NewRegistry(dataRoot)
	owned.Wait = func(time.Duration) {}
	writer := &clipboardWriter{}
	ready := func(browser.State) error { return nil }
	options := browser.Options{
		BrowserBin: "chrome", Events: eventLog, DataRoot: dataRoot, Repository: repo, Launcher: launcher{},
		DisplayRuntime: display{}, ReadinessProbe: ready, ViewerReadinessProbe: ready, Owned: owned,
		StopGrace: 10 * time.Millisecond, ClipboardWriter: writer,
	}
	if configure != nil {
		configure(&options)
	}
	runtime := browser.New(options)
	cfg := config.Config{AuthToken: token, DataRoot: dataRoot, Host: "127.0.0.1", MaxRunningInstances: 10}
	store := viewer.Open(dataRoot, nil)
	gateway := &cdp.Gateway{Runtime: runtime, Profiles: service, GetJSON: func(port int, path string) (any, error) {
		return map[string]any{"webSocketDebuggerUrl": fmt.Sprintf("ws://127.0.0.1:%d/devtools/browser/b", port)}, nil
	}}
	server := httptest.NewServer(New(cfg, Services{Events: eventLog, Viewer: store, Runtime: runtime, Profiles: service, Owned: owned, Gateway: gateway}))
	t.Cleanup(server.Close)
	return &hub{t: t, server: server, runtime: runtime, profiles: service, dataRoot: dataRoot, writer: writer}
}

type result struct {
	status int
	header http.Header
	body   string
}

func (r result) json(t *testing.T) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal([]byte(r.body), &value); err != nil {
		t.Fatalf("not JSON (%d): %s", r.status, r.body)
	}
	return value
}

func (h *hub) do(method, path, body string, headers ...string) result {
	h.t.Helper()
	request, _ := http.NewRequest(method, h.server.URL+path, strings.NewReader(body))
	for i := 0; i+1 < len(headers); i += 2 {
		request.Header.Set(headers[i], headers[i+1])
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return result{response.StatusCode, response.Header, string(raw)}
}

const admin = "Authorization"

func TestHealthAuthAndErrorContract(t *testing.T) {
	h := newHub(t, "admin-token", nil)
	if r := h.do("GET", "/api/health", ""); r.status != 200 || r.body != `{"ok":true}` || r.header.Get("Cache-Control") != "no-store" {
		t.Errorf("health %+v", r)
	}
	unauthorized := h.do("GET", "/api/profiles", "")
	if body := unauthorized.json(t); unauthorized.status != 401 || body["code"] != "UNAUTHORIZED" || body["error"] != "Unauthorized" || body["retryable"] != false {
		t.Errorf("unauthorized %+v", unauthorized)
	}
	if r := h.do("GET", "/api/profiles", "", admin, "Bearer wrong"); r.status != 401 {
		t.Errorf("wrong token %d", r.status)
	}
	if r := h.do("GET", "/api/profiles", "", admin, "Bearer admin-token"); r.status != 200 || r.body != "[]" {
		t.Errorf("authorized %+v", r)
	}
	// The UI uses the cookie, not the bearer token, and vice versa.
	if r := h.do("GET", "/ui/profiles", "", admin, "Bearer admin-token"); r.status != 401 {
		t.Errorf("bearer on UI %d", r.status)
	}
	if r := h.do("GET", "/ui/profiles", "", "Cookie", "cloakhub_auth=admin-token"); r.status != 200 {
		t.Errorf("cookie on UI %d", r.status)
	}
	if r := h.do("GET", "/api/profiles", "", "Cookie", "cloakhub_auth=admin-token"); r.status != 401 {
		t.Errorf("cookie on API %d", r.status)
	}
	notFound := h.do("GET", "/api/nothing", "", admin, "Bearer admin-token")
	if body := notFound.json(t); notFound.status != 404 || body["code"] != "NOT_FOUND" || body["error"] != "Not found" {
		t.Errorf("not found %+v", notFound)
	}
	method := h.do("PUT", "/api/profiles", "", admin, "Bearer admin-token")
	if body := method.json(t); method.status != 405 || body["code"] != "METHOD_NOT_ALLOWED" || method.header.Get("Allow") != "GET, POST" {
		t.Errorf("method %+v", method)
	}
	// CDP routes do their own (CDP Token) authorization.
	if r := h.do("GET", "/api/profiles/missing/cdp", ""); r.status == 401 {
		t.Error("admin auth applied to CDP")
	}
	login := h.do("GET", "/", "")
	if login.status != 401 || !strings.Contains(login.body, `id="login-form"`) {
		t.Errorf("login page %d", login.status)
	}
}

func TestLogin(t *testing.T) {
	h := newHub(t, "admin token+/", nil)
	if r := h.do("POST", "/api/auth/login", `{"token":"bad"}`); r.status != 401 {
		t.Errorf("bad login %d", r.status)
	}
	r := h.do("POST", "/api/auth/login", `{"token":"admin token+/"}`)
	cookie := r.header.Get("Set-Cookie")
	if r.status != 204 || cookie != "cloakhub_auth=admin%20token%2B%2F; HttpOnly; Path=/; SameSite=Lax" {
		t.Fatalf("login %d %q", r.status, cookie)
	}
	value := strings.TrimPrefix(strings.Split(cookie, ";")[0], "cloakhub_auth=")
	if page := h.do("GET", "/", "", "Cookie", "cloakhub_auth="+value); page.status != 200 || !strings.Contains(page.body, `id="bootstrap"`) {
		t.Errorf("dashboard with cookie %d", page.status)
	}
	open := newHub(t, "", nil)
	if r := open.do("POST", "/api/auth/login", ""); r.status != 204 {
		t.Errorf("open login %d", r.status)
	}
}

func TestProfileCrudSummariesAndConnections(t *testing.T) {
	h := newHub(t, "", nil)
	created := h.do("POST", "/api/profiles", `{"profile_id":"work","display_name":"Work","proxy":"http://user:secret@proxy.example:8080"}`)
	body := created.json(t)
	if created.status != 201 || body["timezone"] != "Asia/Tokyo" || body["locale"] != "ja-JP" || body["platform"] != "macos" ||
		body["proxy"] != "http://user:secret@proxy.example:8080" || body["cdp_token_configured"] != false {
		t.Fatalf("create %+v", created)
	}
	if _, leaked := body["cdp_token"]; leaked {
		t.Error("cdp_token serialized")
	}
	connection := body["connection"].(map[string]any)
	base := h.server.URL
	if connection["cdp_url"] != base+"/api/profiles/work/cdp" || connection["cdp_ws_url"] != "ws"+strings.TrimPrefix(base, "http")+"/api/profiles/work/cdp" || connection["auth"] != "none" {
		t.Errorf("connection %+v", connection)
	}
	if r := h.do("POST", "/api/profiles", `{"profile_id":"work"}`); r.status != 409 || r.json(t)["code"] != "PROFILE_ALREADY_EXISTS" {
		t.Errorf("duplicate %+v", r)
	}
	if r := h.do("POST", "/api/profiles", `{`); r.status != 400 || r.json(t)["error"] != "Request body must be valid JSON" {
		t.Errorf("bad json %+v", r)
	}
	if r := h.do("POST", "/api/profiles", `[]`); r.status != 400 || r.json(t)["error"] != "Request body must be a JSON object" {
		t.Errorf("array body %+v", r)
	}
	summary := h.do("GET", "/api/profiles?view=summary", "", "X-Forwarded-Host", "hub.example", "X-Forwarded-Proto", "https")
	var summaries []map[string]any
	json.Unmarshal([]byte(summary.body), &summaries)
	if len(summaries) != 1 || summaries[0]["connection"].(map[string]any)["cdp_ws_url"] != "wss://hub.example/api/profiles/work/cdp" {
		t.Errorf("summary %s", summary.body)
	}
	if _, full := summaries[0]["proxy"]; full {
		t.Error("summary includes launch settings")
	}
	if r := h.do("GET", "/api/profiles?view=bogus", ""); r.status != 400 {
		t.Errorf("bad view %d", r.status)
	}
	ui := h.do("GET", "/ui/profiles/work", "").json(t)
	if ui["proxy"] != "http://user:***@proxy.example:8080" || ui["connection"] != nil {
		t.Errorf("UI view must mask proxy and omit connection: %v %v", ui["proxy"], ui["connection"])
	}
	patched := h.do("PATCH", "/api/profiles/work", `{"notes":"n","sleep_policy":{"mode":"never"}}`).json(t)
	if patched["notes"] != "n" || patched["sleep_policy_label"] != "never-sleep" || patched["sleep_status"] != "Sleep Blocker: never-sleep policy" {
		t.Errorf("patch %+v", patched)
	}
	if r := h.do("PATCH", "/api/profiles/work", `{"profile_id":"other"}`); r.status != 400 {
		t.Errorf("rename %d", r.status)
	}
	if r := h.do("GET", "/api/profiles/missing", ""); r.status != 404 || r.json(t)["code"] != "PROFILE_NOT_FOUND" {
		t.Errorf("missing %+v", r)
	}
	defaults := h.do("GET", "/api/profile-defaults", "").json(t)
	if defaults["timezone"] != "Asia/Tokyo" || defaults["fingerprint_seed"] != "" {
		t.Errorf("defaults %+v", defaults)
	}
	if r := h.do("DELETE", "/api/profiles/work", ""); r.status != 204 {
		t.Errorf("delete %d %s", r.status, r.body)
	}
	if _, err := os.Stat(filepath.Join(h.dataRoot, "profiles", "work")); !os.IsNotExist(err) {
		t.Error("profile data kept after delete")
	}
}

func TestLifecycleAndCapacityErrors(t *testing.T) {
	h := newHub(t, "", func(o *browser.Options) { o.MaxRunningInstances = 1 })
	h.do("POST", "/api/profiles", `{"profile_id":"a","headless":true}`)
	h.do("POST", "/api/profiles", `{"profile_id":"b","headless":true}`)
	started := h.do("POST", "/api/profiles/a/start", "").json(t)
	if started["instance_status"] != "running" || started["status"] != "running" || started["connection"] == nil {
		t.Errorf("start %+v", started)
	}
	if ui := h.do("POST", "/ui/profiles/a/start", "").json(t); ui["connection"] != nil {
		t.Error("UI lifecycle response includes connection")
	}
	if _, err := h.runtime.OpenCdpSession("a", "", ""); err != nil {
		t.Fatal(err)
	}
	full := h.do("POST", "/api/profiles/b/start", "")
	if body := full.json(t); full.status != 503 || body["code"] != "CAPACITY_UNAVAILABLE" || body["retryable"] != true {
		t.Errorf("capacity %+v", full)
	}
	if r := h.do("GET", "/api/profiles/a/start", ""); r.status != 405 || r.header.Get("Allow") != "POST" {
		t.Errorf("start method %d", r.status)
	}
	listing := h.do("GET", "/api/profiles/a", "").json(t)
	if listing["cdp_session_count"].(float64) != 1 || !strings.HasPrefix(listing["sleep_status"].(string), "Sleep Blocker: active CDP Session") {
		t.Errorf("observations %+v", listing)
	}
	if stopped := h.do("POST", "/api/profiles/a/stop", "").json(t); stopped["instance_status"] != "stopped" {
		t.Errorf("stop %+v", stopped)
	}
	if r := h.do("POST", "/api/profiles/missing/start", ""); r.status != 404 {
		t.Errorf("missing start %d", r.status)
	}
}

func TestCdpTokenRoutes(t *testing.T) {
	h := newHub(t, "admin", nil)
	auth := []string{admin, "Bearer admin"}
	h.do("POST", "/api/profiles", `{"profile_id":"work","headless":true}`, auth...)
	created := h.do("POST", "/api/profiles/work/cdp-token", "", auth...)
	token, _ := created.json(t)["cdp_token"].(string)
	if created.status != 201 || !strings.HasPrefix(token, "cdp_") {
		t.Fatalf("create %+v", created)
	}
	if again := h.do("POST", "/api/profiles/work/cdp-token", "", auth...).json(t); again["cdp_token"] != token {
		t.Error("create is not idempotent")
	}
	summary := h.do("GET", "/api/profiles/work?view=summary", "", auth...).json(t)
	if summary["connection"].(map[string]any)["auth"] != "cdp_token" {
		t.Errorf("auth %+v", summary)
	}
	if r := h.do("GET", "/api/profiles/work/cdp", ""); r.status != 401 {
		t.Errorf("CDP without token %d", r.status)
	}
	discovery := h.do("GET", "/api/profiles/work/cdp/json/version?token="+token, "")
	if discovery.status != 200 || !strings.Contains(discovery.body, "/api/profiles/work/cdp/devtools/browser/b?token="+token) {
		t.Errorf("discovery %+v", discovery)
	}
	if r := h.do("GET", "/api/profiles/work/cdp/json/close/x", "", "Authorization", "Bearer "+token); r.status != 405 {
		t.Errorf("HTTP close %d", r.status)
	}
	regenerated := h.do("POST", "/api/profiles/work/cdp-token/regenerate", "", auth...).json(t)
	if regenerated["cdp_token"] == token {
		t.Error("regenerate kept the token")
	}
	if r := h.do("GET", "/api/profiles/work/cdp-token/regenerate", "", auth...); r.status != 405 || r.header.Get("Allow") != "POST" {
		t.Errorf("regenerate method %d", r.status)
	}
	if r := h.do("DELETE", "/api/profiles/work/cdp-token", "", auth...); r.status != 204 {
		t.Errorf("revoke %d", r.status)
	}
	if r := h.do("GET", "/api/profiles/missing/cdp-token", "", auth...); r.status != 404 {
		t.Errorf("missing %d", r.status)
	}
	if r := h.do("GET", "/api/profiles/work/cdp-token", ""); r.status != 401 {
		t.Errorf("token route without admin %d", r.status)
	}
}

func TestViewerPagesAndClipboard(t *testing.T) {
	h := newHub(t, "", nil)
	h.do("POST", "/api/profiles", `{"profile_id":"work"}`)
	h.do("POST", "/api/profiles", `{"profile_id":"bg","headless":true}`)
	page := h.do("GET", "/ui/profiles/work/viewer", "")
	if page.status != 200 || !strings.Contains(page.body, `data-display-path="/ui/profiles/work/display/"`) || !strings.Contains(page.body, `id="display-frame"`) || !strings.Contains(page.body, `data-clipboard-sync="true"`) {
		t.Errorf("viewer page %d %s", page.status, page.body)
	}
	if r := h.do("GET", "/ui/profiles/bg/viewer", ""); r.status != 400 || !strings.Contains(r.body, "headless") {
		t.Errorf("headless viewer %d", r.status)
	}
	if r := h.do("GET", "/ui/profiles/missing/viewer", ""); r.status != 404 {
		t.Errorf("missing viewer %d", r.status)
	}
	if r := h.do("GET", "/ui/profiles/work/display/ws", ""); r.status != 426 {
		t.Errorf("ws without upgrade %d", r.status)
	}
	if r := h.do("GET", "/ui/profiles/work/display/secret.txt", ""); r.status != 404 {
		t.Errorf("unlisted asset %d", r.status)
	}
	if r := h.do("POST", "/ui/profiles/work/clipboard", `{"text":"hello"}`); r.status != 200 || h.writer.text != "hello" {
		t.Errorf("clipboard %+v", r)
	}
	if r := h.do("POST", "/ui/profiles/work/clipboard", `{}`); r.status != 400 {
		t.Errorf("clipboard without text %d", r.status)
	}
}

func TestDisplayProxyRelaysAssetsAndStream(t *testing.T) {
	listener, port := freeViewerPort(t)
	var mu sync.Mutex
	var fromViewer []string
	upgrader := websocket.Upgrader{}
	voxl := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/client.js" {
			w.Header().Set("Content-Type", "text/javascript")
			w.Write([]byte("console.log(1)"))
			return
		}
		if r.URL.Path != "/ws" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Origin") != "" {
			http.Error(w, "origin", 403)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"hello","w":1,"h":1}`))
		conn.WriteMessage(websocket.TextMessage, []byte(`{"d":"secret","t":"clip"}`))
		conn.WriteMessage(websocket.BinaryMessage, []byte{0x04, 0x89})
		conn.WriteMessage(websocket.BinaryMessage, []byte{0x01, 0x02})
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			mu.Lock()
			fromViewer = append(fromViewer, fmt.Sprintf("%d:%x", kind, data))
			mu.Unlock()
		}
	})}
	go voxl.Serve(listener)
	defer voxl.Close()

	h := newHub(t, "", func(o *browser.Options) { o.ViewerPortStart = port })
	h.do("POST", "/api/profiles", `{"profile_id":"work","clipboard_sync":false}`)
	asset := h.do("GET", "/ui/profiles/work/display/client.js", "")
	if asset.status != 200 || asset.body != "console.log(1)" || asset.header.Get("Content-Type") != "text/javascript" {
		t.Errorf("asset %+v", asset)
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.server.URL, "http")+"/ui/profiles/work/display/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var received []string
	for len(received) < 2 {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		received = append(received, fmt.Sprintf("%d:%s", kind, data))
	}
	if received[0] != `1:{"t":"hello","w":1,"h":1}` || received[1] != "2:\x01\x02" {
		t.Errorf("clipboard updates must be dropped while sync is off: %q", received)
	}
	if h.runtime.ActiveViewerCount("work") != 1 {
		t.Error("viewer presence not tracked")
	}
	for _, message := range []string{"k,65,1", "c,secret", "mi,1", "a,1"} {
		conn.WriteMessage(websocket.TextMessage, []byte(message))
	}
	conn.WriteMessage(websocket.BinaryMessage, []byte{0x11, 0x89})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(fromViewer)
		mu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	got := strings.Join(fromViewer, ",")
	mu.Unlock()
	if got != "1:6b2c36352c31,1:612c31" {
		t.Errorf("forwarded %s (want key and ack only)", got)
	}
	if p := h.profiles.Get("work"); p.LastManualInputAt == nil {
		t.Error("key press not recorded as manual input")
	}
}

func TestClassifyViewerMessages(t *testing.T) {
	for _, command := range []string{"m,1,2", "b,0,1", "sp,0,1", "k,65,1", "c,x"} {
		if forward, manual := classifyClientMessage(websocket.TextMessage, []byte(command), true); !forward || !manual {
			t.Errorf("%s", command)
		}
	}
	for _, command := range []string{"a,1", "v,1", "kf", "po,1", "r"} {
		if forward, manual := classifyClientMessage(websocket.TextMessage, []byte(command), true); !forward || manual {
			t.Errorf("%s", command)
		}
	}
	if forward, _ := classifyClientMessage(websocket.TextMessage, []byte("sz,1,1"), true); forward {
		t.Error("resize forwarded")
	}
	if forward, _ := classifyClientMessage(websocket.BinaryMessage, []byte{0x13}, true); forward {
		t.Error("microphone forwarded")
	}
	if !forwardServerMessage(websocket.TextMessage, []byte(`{"t":"clip"}`), true) || forwardServerMessage(websocket.TextMessage, []byte(`{"d":"x","t":"clip"}`), false) {
		t.Error("server clipboard filtering")
	}
}

func TestEventsAndViewerSettings(t *testing.T) {
	h := newHub(t, "", nil)
	h.do("POST", "/api/profiles", `{"profile_id":"work","headless":true}`)
	h.do("POST", "/api/profiles/work/start", "")
	page := h.do("GET", "/api/events?profile_id=work&limit=1", "").json(t)
	if len(page["events"].([]any)) != 1 || page["next_before"] == nil {
		t.Errorf("events %+v", page)
	}
	for _, query := range []string{"limit=0", "limit=201", "before=x", "since=yesterday", "since=2026-02-01T00:00:00Z&until=2026-01-01T00:00:00Z"} {
		if r := h.do("GET", "/api/events?"+query, ""); r.status != 400 {
			t.Errorf("%s accepted", query)
		}
	}
	if r := h.do("GET", "/api/events?since=2026-01-01T00:00:00Z", ""); r.status != 200 {
		t.Errorf("since %d", r.status)
	}
	settings := h.do("GET", "/api/viewer-settings", "").json(t)
	if settings["preset"] != "balanced" || settings["settings"].(map[string]any)["max_kbps"].(float64) != 8000 {
		t.Errorf("settings %+v", settings)
	}
	if updated := h.do("PUT", "/ui/viewer-settings", `{"preset":"data-saver"}`).json(t); updated["preset"] != "data-saver" {
		t.Errorf("update %+v", updated)
	}
	if r := h.do("PUT", "/api/viewer-settings", `{"framerate":0}`); r.status != 400 {
		t.Errorf("invalid settings %d", r.status)
	}
	custom := h.do("PUT", "/api/viewer-settings", `{"max_kbps":1000}`).json(t)
	if custom["preset"] != "custom" || custom["settings"].(map[string]any)["framerate"].(float64) != 30 {
		t.Errorf("partial update %+v", custom)
	}
}

func TestAssetsAndShell(t *testing.T) {
	dist := t.TempDir()
	os.WriteFile(filepath.Join(dist, "app.js"), []byte("app"), 0o644)
	t.Setenv("CLOAKHUB_UI_DIST", dist)
	h := newHub(t, "", nil)
	if r := h.do("GET", "/assets/app.js", ""); r.status != 200 || r.body != "app" || !strings.HasPrefix(r.header.Get("Content-Type"), "text/javascript") || r.header.Get("Cache-Control") != "no-cache" {
		t.Errorf("asset %+v", r)
	}
	if r := h.do("GET", "/assets/viewer.js", ""); r.status != 503 {
		t.Errorf("missing bundle %d", r.status)
	}
	if r := h.do("GET", "/favicon.svg", ""); r.status != 200 || !strings.Contains(r.body, "<svg") {
		t.Errorf("favicon %d", r.status)
	}
	h.do("POST", "/api/profiles", `{"profile_id":"work","proxy":"http://u:pw@h:8080","notes":"</script><b>"}`)
	shell := h.do("GET", "/", "")
	if shell.status != 200 || !strings.Contains(shell.body, `"profile_id":"work"`) || strings.Contains(shell.body, "</script><b>") || strings.Contains(shell.body, ":pw@") {
		t.Errorf("shell must embed escaped, redacted bootstrap data")
	}
}
