// Package integration runs CloakHub against a real CloakBrowser, Xvfb and voxl.
// The tests are opt-in: set CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true and
// CLOAKHUB_BROWSER_BIN, typically inside the CloakHub image (see docs/development.md).
package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
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
	"github.com/txchen/cloakhub/internal/web"
)

type clock struct {
	mu     sync.Mutex
	offset time.Duration
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.offset)
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.offset += d
}

type fixture struct {
	t        *testing.T
	runtime  *browser.Runtime
	profiles *profile.Service
	repo     *profile.Repository
	events   *events.Log
	server   *httptest.Server
	clock    *clock
}

func newFixture(t *testing.T, requireDisplay bool) *fixture {
	t.Helper()
	if os.Getenv("CLOAKHUB_RUN_REAL_RUNTIME_TESTS") != "true" {
		t.Skip("set CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true to run against a real browser")
	}
	browserBin := os.Getenv("CLOAKHUB_BROWSER_BIN")
	if !procs.IsExecutable(browserBin) {
		t.Fatal("CLOAKHUB_BROWSER_BIN must name an executable CloakBrowser")
	}
	bins := browser.ResolveDisplayBins("", "", "")
	if requireDisplay && bins.Warning != "" {
		t.Fatal("headed integration tests require Xvfb and voxl")
	}
	dataRoot := t.TempDir()
	repo, err := profile.OpenRepository(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	repo.Migrate()
	eventLog, _ := events.Open(dataRoot)
	profiles, _ := profile.NewService(profile.ServiceOptions{DataRoot: dataRoot, Repository: repo})
	owned := procs.NewRegistry(dataRoot)
	launcher := browser.NewProcessLauncher(dataRoot, 64, "", nil)
	launcher.Owned = owned
	display := &browser.VoxlDisplayRuntime{XvfbBin: bins.Xvfb, VoxlBin: bins.Voxl, Owned: owned}
	settings := viewer.Open(dataRoot, nil)
	display.Settings = settings.Get
	c := &clock{}
	runtime := browser.New(browser.Options{
		BrowserBin: browserBin, Events: eventLog, DataRoot: dataRoot, Repository: repo, Launcher: launcher,
		DisplayRuntime: display, Owned: owned, Now: c.now, ClipboardReader: browser.CdpClipboardReader{},
		StopGrace: stopGrace(),
	})
	gateway := &cdp.Gateway{Runtime: runtime, Profiles: profiles}
	relay := &cdp.Relay{Sessions: tracker{runtime}, Guard: &cdp.TabGuard{}}
	cfg := config.Config{DataRoot: dataRoot, Host: "127.0.0.1", MaxRunningInstances: 10, LicenseMode: "none"}
	server := httptest.NewServer(web.New(cfg, web.Services{Events: eventLog, Viewer: settings, Runtime: runtime,
		Gateway: gateway, Relay: relay, Profiles: profiles, Owned: owned}))
	f := &fixture{t: t, runtime: runtime, profiles: profiles, repo: repo, events: eventLog, server: server, clock: c}
	t.Cleanup(func() {
		server.Close()
		runtime.Shutdown()
		repo.Close()
		eventLog.Close()
	})
	return f
}

func stopGrace() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("CLOAKHUB_TEST_STOP_GRACE")); err == nil {
		return d
	}
	return 0
}

type tracker struct{ runtime *browser.Runtime }

func (t tracker) OpenCdpSession(id, address, agent string) (cdp.Session, error) {
	return t.runtime.OpenCdpSession(id, address, agent)
}

func (f *fixture) create(body string) {
	f.t.Helper()
	input, err := profile.DecodeObject([]byte(body))
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.profiles.Create(input); err != nil {
		f.t.Fatal(err)
	}
}

func getJSON(t *testing.T, target string, header http.Header, into any) int {
	t.Helper()
	request, _ := http.NewRequest("GET", target, nil)
	if header != nil {
		request.Header = header
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if into != nil && response.StatusCode < 300 {
		if err := json.Unmarshal(raw, into); err != nil {
			t.Fatalf("%s: %v %s", target, err, raw)
		}
	}
	return response.StatusCode
}

func post(t *testing.T, target string) map[string]any {
	t.Helper()
	response, err := http.Post(target, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	json.NewDecoder(response.Body).Decode(&body)
	if response.StatusCode != 200 {
		t.Fatalf("%s: %d %v", target, response.StatusCode, body)
	}
	return body
}

// cdpCommand sends one command over a CDP WebSocket and returns its result.
func cdpCommand(t *testing.T, endpoint, method string, params map[string]any) map[string]any {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", endpoint, err)
	}
	defer conn.Close()
	return send(t, conn, 1, method, params)
}

func send(t *testing.T, conn *websocket.Conn, id int, method string, params map[string]any) map[string]any {
	t.Helper()
	if params == nil {
		params = map[string]any{}
	}
	conn.WriteJSON(map[string]any{"id": id, "method": method, "params": params})
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		var message struct {
			ID     int             `json:"id"`
			Result map[string]any  `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := conn.ReadJSON(&message); err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		if message.ID == id {
			if len(message.Error) > 0 {
				t.Fatalf("%s: %s", method, message.Error)
			}
			return message.Result
		}
	}
}

// pageSession navigates a page target of the browser at cdpPort and evaluates.
type pageSession struct {
	t    *testing.T
	conn *websocket.Conn
	id   int
}

func openPage(t *testing.T, cdpPort int, address string) *pageSession {
	t.Helper()
	var targets []map[string]any
	getJSON(t, fmt.Sprintf("http://127.0.0.1:%d/json", cdpPort), nil, &targets)
	endpoint := ""
	for _, target := range targets {
		if target["type"] == "page" {
			endpoint, _ = target["webSocketDebuggerUrl"].(string)
			break
		}
	}
	if endpoint == "" {
		request, _ := http.NewRequest("PUT", fmt.Sprintf("http://127.0.0.1:%d/json/new", cdpPort), nil)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var created map[string]any
		json.NewDecoder(response.Body).Decode(&created)
		response.Body.Close()
		endpoint = created["webSocketDebuggerUrl"].(string)
	}
	conn, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	session := &pageSession{t: t, conn: conn, id: 1}
	session.call("Page.enable", nil)
	session.call("Page.navigate", map[string]any{"url": address})
	time.Sleep(500 * time.Millisecond)
	return session
}

func (s *pageSession) call(method string, params map[string]any) map[string]any {
	s.id++
	return send(s.t, s.conn, s.id, method, params)
}

func (s *pageSession) evaluate(expression string) string {
	result := s.call("Runtime.evaluate", map[string]any{"expression": expression, "awaitPromise": true, "returnByValue": true})
	value, _ := result["result"].(map[string]any)["value"].(string)
	return value
}

func (s *pageSession) close() { s.conn.Close() }

func TestDefaultHeadedProfileDrawsWithWebGL(t *testing.T) {
	f := newFixture(t, true)
	f.create(`{"profile_id":"graphics","fingerprint_seed":"20260909"}`)
	state, err := f.runtime.Start("graphics")
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, state.CdpPort, "data:text/html,<title>Graphics regression</title>")
	defer page.close()
	raw := page.evaluate(`JSON.stringify({
		platform: navigator.platform,
		contexts: ['webgl', 'webgl2'].map(kind => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 2;
			const gl = canvas.getContext(kind);
			if (!gl) return { kind, available: false };
			gl.clearColor(0.2, 0.4, 0.6, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			const pixel = new Uint8Array(4);
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
			return { kind, available: true, pixel: Array.from(pixel), error: gl.getError() };
		})
	})`)
	if !strings.Contains(raw, "Linux") || strings.Count(raw, `"pixel":[51,102,153,255],"error":0`) != 2 {
		t.Errorf("graphics %s", raw)
	}
}

func TestAgentUsesProtectedConnectionMetadata(t *testing.T) {
	f := newFixture(t, false)
	f.create(`{"profile_id":"agent","headless":true}`)
	f.profiles.CreateCdpToken("agent")
	base := f.server.URL
	var summaries []struct {
		ProfileID      string `json:"profile_id"`
		InstanceStatus string `json:"instance_status"`
		Connection     struct {
			CdpURL, CdpWsURL, Auth, CdpTokenURL string
		} `json:"connection"`
	}
	getJSON(t, base+"/api/profiles?view=summary", nil, &summaries)
	var listed []struct {
		Connection map[string]string `json:"connection"`
	}
	getJSON(t, base+"/api/profiles?view=summary", nil, &listed)
	connection := listed[0].Connection
	if summaries[0].InstanceStatus != "stopped" || connection["auth"] != "cdp_token" {
		t.Fatalf("summary %+v %v", summaries, connection)
	}
	if status := getJSON(t, connection["cdp_url"], nil, nil); status != 401 || f.repo.Get("agent").InstanceStatus != "stopped" {
		t.Errorf("unauthenticated discovery %d must not wake the profile", status)
	}
	var token struct {
		CdpToken string `json:"cdp_token"`
	}
	getJSON(t, connection["cdp_token_url"], nil, &token)
	var wg sync.WaitGroup
	starts := make([]map[string]any, 2)
	for i := range starts {
		wg.Add(1)
		go func(i int) { defer wg.Done(); starts[i] = post(t, base+"/api/profiles/agent/start") }(i)
	}
	wg.Wait()
	if starts[0]["instance_status"] != "running" || fmt.Sprint(starts[0]) != fmt.Sprint(starts[1]) {
		t.Errorf("starts %v", starts)
	}
	var version map[string]any
	getJSON(t, connection["cdp_url"], http.Header{"Authorization": {"Bearer " + token.CdpToken}}, &version)
	socket, _ := url.Parse(version["webSocketDebuggerUrl"].(string))
	query := socket.Query()
	query.Set("token", token.CdpToken)
	socket.RawQuery = query.Encode()
	if product := cdpCommand(t, socket.String(), "Browser.getVersion", nil)["product"]; !strings.Contains(fmt.Sprint(product), "Chrome") {
		t.Errorf("product %v", product)
	}
	for range 2 {
		if stopped := post(t, base+"/api/profiles/agent/stop"); stopped["instance_status"] != "stopped" {
			t.Errorf("stop %v", stopped)
		}
	}
	stable, _ := url.Parse(connection["cdp_ws_url"])
	stable.RawQuery = "token=" + url.QueryEscape(token.CdpToken)
	cdpCommand(t, stable.String(), "Browser.getVersion", nil)
	if f.repo.Get("agent").InstanceStatus != "running" {
		t.Error("stable WebSocket URL did not wake the profile")
	}
}

func TestRegionalSettingsApplyToPages(t *testing.T) {
	f := newFixture(t, false)
	f.create(`{"profile_id":"regional","headless":true,"timezone":"America/Los_Angeles","locale":"fr-FR","color_scheme":"dark"}`)
	state, err := f.runtime.Start("regional")
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, state.CdpPort, "data:text/html,<title>Regional settings</title>")
	defer page.close()
	got := page.evaluate("JSON.stringify({ timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, locale:navigator.language, dark:matchMedia('(prefers-color-scheme: dark)').matches })")
	if got != `{"timezone":"America/Los_Angeles","locale":"fr-FR","dark":true}` {
		t.Errorf("regional %s", got)
	}
}

func TestHeadedViewerPathStreams(t *testing.T) {
	f := newFixture(t, true)
	f.create(`{"profile_id":"headed"}`)
	viewerState, err := f.runtime.OpenManualViewer("headed")
	if err != nil {
		t.Fatal(err)
	}
	if viewerState.DisplayPath != "/ui/profiles/headed/display/" {
		t.Errorf("path %s", viewerState.DisplayPath)
	}
	if status := getJSON(t, f.server.URL+"/ui/profiles/headed/display/client.js", nil, nil); status != 200 {
		t.Errorf("voxl client asset %d", status)
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.server.URL, "http")+"/ui/profiles/headed/display/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.TextMessage {
			if !strings.Contains(string(data), `"t":"hello"`) {
				t.Errorf("first text message %s", data)
			}
			break
		}
	}
	if f.runtime.ActiveViewerCount("headed") != 1 {
		t.Error("viewer presence")
	}
}

func TestSpinDownRecoversWithPersistence(t *testing.T) {
	f := newFixture(t, false)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte("<!doctype html><title>CloakHub persistence</title>"))
	}))
	defer origin.Close()
	f.create(`{"profile_id":"persistent","headless":true,"sleep_policy":{"mode":"minutes","minutes":1}}`)
	first, err := f.runtime.Start("persistent")
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, first.CdpPort, origin.URL)
	page.evaluate("localStorage.setItem('cloakhubPersistence', 'kept'); document.cookie = 'cloakhub_cookie=kept; path=/; max-age=3600'; 'ok'")
	page.close()
	f.clock.advance(61 * time.Second)
	results := f.runtime.SpinDownIdle()
	if len(results) != 1 || results[0].ProfileID != "persistent" {
		t.Fatalf("spin down %v", results)
	}
	history, _ := f.events.List(events.Query{ProfileID: "persistent"})
	if history.Events[0].Type != "browser.stopped" || history.Events[0].Details["reason"] != "idle timeout" {
		t.Errorf("history %+v", history.Events[0])
	}
	client := http.Client{Timeout: time.Second}
	if _, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", first.CdpPort)); err == nil {
		t.Error("browser still answering after spin-down")
	}
	second, err := f.runtime.Start("persistent")
	if err != nil {
		t.Fatal(err)
	}
	again := openPage(t, second.CdpPort, origin.URL)
	defer again.close()
	if got := again.evaluate("localStorage.getItem('cloakhubPersistence') + '|' + document.cookie"); !strings.HasPrefix(got, "kept|") || !strings.Contains(got, "cloakhub_cookie=kept") {
		t.Errorf("persisted %q", got)
	}
}

func TestExplicitStopOverridesActiveClients(t *testing.T) {
	f := newFixture(t, false)
	f.create(`{"profile_id":"active","headless":true}`)
	if _, err := f.runtime.Start("active"); err != nil {
		t.Fatal(err)
	}
	session, _ := f.runtime.OpenCdpSession("active", "", "")
	if _, err := f.runtime.Stop("active", profile.StopManual); err != nil {
		t.Fatal(err)
	}
	if f.repo.Get("active").InstanceStatus != "stopped" || f.runtime.ActiveCdpSessionCount("active") != 0 {
		t.Error("stop must override active clients")
	}
	session.Close()
}
