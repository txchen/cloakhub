package browser

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/viewer"
)

func TestBrowserArgs(t *testing.T) {
	args := BrowserArgs(LaunchCommand{
		CdpPort: 5100, UserDataDir: "/data/profiles/work", ScreenWidth: 1366, ScreenHeight: 768,
		FingerprintSeed: "123", Platform: "macos", HardwareConcurrency: 4, Timezone: "Asia/Tokyo",
		Locale: "ja-JP", ColorScheme: "dark", GPUVendor: "Apple", CustomLaunchArgs: []string{"--x"},
	}, "http://127.0.0.1:9", 256)
	for _, want := range []string{
		"--user-data-dir=/data/profiles/work", "--disk-cache-size=268435456", "--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=5100", "--window-size=1366,768", "--fingerprint=123", "--fingerprint-platform=macos",
		"--fingerprint-gpu-vendor=Apple", "--fingerprint-hardware-concurrency=4", "--fingerprint-timezone=Asia/Tokyo",
		"--lang=ja-JP", "--accept-lang=ja-JP", "--fingerprint-locale=ja-JP", "--blink-settings=preferredColorScheme=0",
		"--proxy-server=http://127.0.0.1:9", "--use-angle=swiftshader", "--disable-gpu",
	} {
		if !slices.Contains(args, want) {
			t.Errorf("missing %s in %v", want, args)
		}
	}
	if args[len(args)-1] != "--x" || slices.Contains(args, "--headless=new") {
		t.Errorf("custom args must come last; headed has no --headless: %v", args)
	}
	headless := BrowserArgs(LaunchCommand{Headless: true, ColorScheme: "system"}, "", 1)
	if !slices.Contains(headless, "--headless=new") || slices.Contains(headless, "--use-gl=angle") ||
		slices.ContainsFunc(headless, func(a string) bool {
			return strings.HasPrefix(a, "--blink-settings") || strings.HasPrefix(a, "--proxy-server")
		}) {
		t.Errorf("headless args %v", headless)
	}
}

// helperProcess re-executes the test binary as a stand-in browser.
func helperProcess(t *testing.T, mode string) func(string, ...string) *exec.Cmd {
	// Launchers rebuild the child environment from os.Environ, so the marker must
	// be set in this process too.
	t.Setenv("CLOAKHUB_HELPER_PROCESS", "1")
	return func(name string, args ...string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess", "--", mode)
		cmd.Env = append(os.Environ(), "CLOAKHUB_HELPER_PROCESS=1")
		return cmd
	}
}

func TestHelperProcess(t *testing.T) {
	if os.Getenv("CLOAKHUB_HELPER_PROCESS") != "1" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	switch mode {
	case "sleep":
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}

func TestLauncherMarksOwnershipAndClearsStaleLocks(t *testing.T) {
	dataRoot := t.TempDir()
	launcher := NewProcessLauncher(dataRoot, 256, "")
	launcher.Owned.Wait = func(time.Duration) {}
	launcher.Command = helperProcess(t, "exit")
	userData := filepath.Join(dataRoot, "profiles", "work")
	os.MkdirAll(userData, 0o755)
	os.WriteFile(filepath.Join(userData, "SingletonLock"), []byte("x"), 0o644)
	handle, err := launcher.Launch(LaunchCommand{BrowserBin: "chrome", ProfileID: "work", UserDataDir: userData, CdpPort: 1})
	if err != nil {
		t.Fatal(err)
	}
	<-handle.Done()
	if _, err := os.Stat(filepath.Join(userData, "SingletonLock")); !os.IsNotExist(err) {
		t.Error("stale singleton lock kept")
	}
	if raw, _ := os.ReadFile(filepath.Join(dataRoot, "runtime", "work", "browser.pid")); len(raw) == 0 {
		t.Error("no pid file")
	}
	if raw, _ := os.ReadFile(filepath.Join(dataRoot, "runtime", "work", "launch.json")); !strings.Contains(string(raw), userData) {
		t.Error("no launch metadata")
	}
}

func TestLauncherEnvironmentCarriesMarkersDisplayAndFonts(t *testing.T) {
	dataRoot := t.TempDir()
	launcher := NewProcessLauncher(dataRoot, 256, "/fonts.conf")
	launcher.Owned.Wait = func(time.Duration) {}
	var launched *exec.Cmd
	launcher.Command = func(name string, args ...string) *exec.Cmd {
		launched = helperProcess(t, "exit")(name, args...)
		return launched
	}
	handle, err := launcher.Launch(LaunchCommand{BrowserBin: "chrome", ProfileID: "work", Platform: "macos", Display: ":100", UserDataDir: filepath.Join(dataRoot, "p"), CdpPort: 1})
	if err != nil {
		t.Fatal(err)
	}
	<-handle.Done()
	env := launched.Env
	for _, want := range []string{"CLOAKHUB_PROFILE_ID=work", "CLOAKHUB_DATA_ROOT=" + dataRoot, "DISPLAY=:100", "FONTCONFIG_FILE=/fonts.conf"} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %s", want)
		}
	}
}

func TestAuthenticatedProxyRelay(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			conn, err := upstream.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				request, err := http.ReadRequest(bufio.NewReader(conn))
				if err != nil {
					return
				}
				mu.Lock()
				seen = append(seen, request.Method+" "+request.RequestURI+" "+request.Header.Get("Proxy-Authorization"))
				mu.Unlock()
				if request.Method == http.MethodConnect {
					io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
					buffer := make([]byte, 4)
					io.ReadFull(conn, buffer)
					conn.Write([]byte("pong"))
					return
				}
				io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
			}(conn)
		}
	}()
	session, err := NewProxyRuntime().Prepare("http://user:p%40ss@" + upstream.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if !strings.HasPrefix(session.BrowserURL(), "http://127.0.0.1:") {
		t.Fatalf("browser url %s", session.BrowserURL())
	}
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("user:p@ss"))

	client, _ := net.Dial("tcp", strings.TrimPrefix(session.BrowserURL(), "http://"))
	fmt.Fprintf(client, "GET http://example.test/a HTTP/1.1\r\nHost: example.test\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(client), nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := io.ReadAll(response.Body)
	client.Close()
	if string(payload) != "hello" {
		t.Errorf("forwarded body %q", payload)
	}

	tunnel, _ := net.Dial("tcp", strings.TrimPrefix(session.BrowserURL(), "http://"))
	defer tunnel.Close()
	fmt.Fprintf(tunnel, "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\nping")
	reader := bufio.NewReader(tunnel)
	status, _ := reader.ReadString('\n')
	reader.ReadString('\n')
	pong := make([]byte, 4)
	io.ReadFull(reader, pong)
	if !strings.Contains(status, "200") || string(pong) != "pong" {
		t.Errorf("tunnel %q %q", status, pong)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || !strings.HasSuffix(seen[0], expected) || seen[1] != "CONNECT example.test:443 "+expected {
		t.Errorf("upstream saw %v", seen)
	}

	for _, proxy := range []string{"", "http://plain.example:8080", "socks5://u:p@socks.example:1080"} {
		direct, _ := NewProxyRuntime().Prepare(proxy)
		if direct.BrowserURL() != proxy {
			t.Errorf("%q relayed unexpectedly: %s", proxy, direct.BrowserURL())
		}
	}
}

func TestDisplayRuntimeStartsDisplayThenStreamerAndRestartsStreams(t *testing.T) {
	dataRoot := t.TempDir()
	owned := procs.NewRegistry(dataRoot)
	owned.Wait = func(time.Duration) {}
	var mu sync.Mutex
	var commands [][]string
	settings := viewer.Presets["high"]
	runtime := &VoxlDisplayRuntime{
		XvfbBin: "/usr/bin/Xvfb", VoxlBin: "/usr/local/bin/voxl", Owned: owned, XRoot: dataRoot,
		Settings: func() viewer.Settings { mu.Lock(); defer mu.Unlock(); return settings },
		Command: func(name string, args ...string) *exec.Cmd {
			mu.Lock()
			commands = append(commands, append([]string{name}, args...))
			mu.Unlock()
			return helperProcess(t, "sleep")(name, args...)
		},
		WaitForDisplay: func(int, *procs.Handle) error { return nil },
	}
	handle, err := runtime.Start(DisplayCommand{ClipboardSync: true, DisplayNumber: 100, ProfileID: "work", ScreenWidth: 1920, ScreenHeight: 1080, ViewerPort: 5900})
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if strings.Join(commands[0], " ") != "/usr/bin/Xvfb :100 -screen 0 1920x1080x24 -dpi 96 -nolisten tcp -ac -shmem -noreset -extension GLX" {
		t.Errorf("xvfb %v", commands[0])
	}
	if got := strings.Join(commands[1], " "); !strings.Contains(got, "--port=5900") || !strings.Contains(got, "--enable-clipboard=true") || !strings.Contains(got, "--max-kbps=15000") {
		t.Errorf("voxl %s", got)
	}
	settings = viewer.Presets["data-saver"]
	mu.Unlock()
	runtime.RestartStreams()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(commands)
		mu.Unlock()
		if n >= 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	if len(commands) < 3 || !strings.Contains(strings.Join(commands[2], " "), "--max-kbps=1250") {
		t.Errorf("restart did not respawn voxl with new settings: %v", commands)
	}
	mu.Unlock()
	for _, kind := range []string{"display.pid", "streamer.pid"} {
		if _, err := os.Stat(filepath.Join(dataRoot, "runtime", "work", kind)); err != nil {
			t.Errorf("%s missing", kind)
		}
	}
	handle.Kill()
	select {
	case <-handle.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("display did not stop")
	}
	time.Sleep(1200 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(commands) != 3 {
		t.Errorf("streamer respawned after stop: %d commands", len(commands))
	}
}

func TestDisplayRuntimeWithoutBinaries(t *testing.T) {
	runtime := &VoxlDisplayRuntime{Owned: procs.NewRegistry(t.TempDir())}
	var missing *MissingDisplayError
	if _, err := runtime.Start(DisplayCommand{}); !errors.As(err, &missing) {
		t.Errorf("got %v", err)
	}
	bins := ResolveDisplayBins("/missing", "/missing", string(os.PathListSeparator))
	if bins.Warning == "" && (bins.Xvfb == "" || bins.Voxl == "") {
		t.Error("missing binaries must warn")
	}
}

func TestStreamerArgsFollowClipboardAndSettings(t *testing.T) {
	args := strings.Join(StreamerArgs(DisplayCommand{ViewerPort: 5901}, viewer.Presets["data-saver"]), " ")
	for _, want := range []string{"--port=5901", "--enable-clipboard=false", "--enable-basic-auth=false", "--audio-enabled=false", "--file-transfers=none", "--framerate=30", "--crf=28", "--min-kbps=625"} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %s in %s", want, args)
		}
	}
}

func TestClipboardReaderTriesPagesUntilOneHasText(t *testing.T) {
	var evaluated []string
	reader := CdpClipboardReader{
		ListTargets: func(int) ([]map[string]any, error) {
			return []map[string]any{
				{"type": "service_worker", "webSocketDebuggerUrl": "ws://sw"},
				{"type": "page", "webSocketDebuggerUrl": "ws://gone"},
				{"type": "page", "webSocketDebuggerUrl": "ws://empty"},
				{"type": "page", "webSocketDebuggerUrl": "ws://copied"},
			}, nil
		},
		Evaluate: func(url string) (string, error) {
			evaluated = append(evaluated, url)
			switch url {
			case "ws://gone":
				return "", errors.New("closed")
			case "ws://copied":
				return "copied text", nil
			}
			return "", nil
		},
	}
	text, err := reader.ReadText(1)
	if err != nil || text != "copied text" || strings.Join(evaluated, ",") != "ws://gone,ws://empty,ws://copied" {
		t.Errorf("%q %v %v", text, err, evaluated)
	}
}

func TestReadinessProbesTimeOutWithReason(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the readiness timeout")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) }))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	if err := CdpReadinessProbe(State{CdpPort: port}); err != nil {
		t.Errorf("ready endpoint: %v", err)
	}
	if err := ViewerReadinessProbe(State{ViewerPort: port}); err != nil {
		t.Errorf("viewer port: %v", err)
	}
	if err := ViewerReadinessProbe(State{}); err == nil {
		t.Error("unallocated viewer port")
	}
}
