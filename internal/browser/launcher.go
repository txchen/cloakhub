package browser

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gorilla/websocket"

	"github.com/txchen/cloakhub/internal/config"
	"github.com/txchen/cloakhub/internal/procs"
)

// ProcessLauncher launches CloakBrowser as an Owned Process.
type ProcessLauncher struct {
	DataRoot            string
	DiskCacheSizeMB     int
	MacOSFontconfigFile string
	LicensePool         *LicensePool
	Owned               *procs.Registry
	Proxies             ProxyRuntime
	// Command builds the process; tests replace it.
	Command func(name string, args ...string) *exec.Cmd
}

// NewProcessLauncher returns a launcher with default helpers.
func NewProcessLauncher(dataRoot string, diskCacheSizeMB int, macOSFontconfig string, pool *LicensePool) *ProcessLauncher {
	return &ProcessLauncher{
		DataRoot:            dataRoot,
		DiskCacheSizeMB:     diskCacheSizeMB,
		MacOSFontconfigFile: macOSFontconfig,
		LicensePool:         pool,
		Owned:               procs.NewRegistry(dataRoot),
		Proxies:             NewProxyRuntime(),
		Command:             exec.Command,
	}
}

// Launch starts the browser with a private CDP port and persistent user data.
func (l *ProcessLauncher) Launch(command LaunchCommand) (ProcessHandle, error) {
	if err := os.MkdirAll(command.UserDataDir, 0o755); err != nil {
		return nil, err
	}
	l.Owned.Cleanup([]string{command.ProfileID}, []procs.Kind{procs.Browser})
	for _, entry := range []string{"SingletonLock", "SingletonSocket", "SingletonCookie"} {
		_ = os.RemoveAll(filepath.Join(command.UserDataDir, entry))
	}
	proxy, err := l.Proxies.Prepare(command.Proxy)
	if err != nil {
		return nil, err
	}
	var lease *LicenseLease
	if l.LicensePool != nil {
		if lease, err = l.LicensePool.Acquire(); err != nil {
			proxy.Close()
			return nil, err
		}
	}
	env := l.Owned.Env(command.ProfileID, nil)
	if lease != nil {
		home, err := prepareLicenseHome(l.DataRoot, lease.Key)
		if err != nil {
			lease.Release()
			proxy.Close()
			return nil, err
		}
		for name, value := range home {
			env = procs.SetEnv(env, name, value)
		}
		env = procs.SetEnv(env, "CLOAKBROWSER_LICENSE_KEY", lease.Key)
	}
	if command.Platform == "macos" && l.MacOSFontconfigFile != "" {
		env = procs.SetEnv(env, "FONTCONFIG_FILE", l.MacOSFontconfigFile)
	}
	if command.Display != "" {
		env = procs.SetEnv(env, "DISPLAY", command.Display)
	}
	cacheMB := l.DiskCacheSizeMB
	if cacheMB == 0 {
		cacheMB = config.DefaultDiskCacheSizeMB
	}
	args := BrowserArgs(command, proxy.BrowserURL(), cacheMB)
	cmd := l.Command(command.BrowserBin, args...)
	cmd.Env = env
	cmd.Stderr = os.Stderr
	process, err := procs.Start(cmd)
	if err != nil {
		if lease != nil {
			lease.Release()
		}
		proxy.Close()
		return nil, err
	}
	// Releasing on kill/close would allow another launch before the actual exit.
	go func() {
		<-process.Done()
		if lease != nil {
			lease.Release()
		}
		proxy.Close()
	}()
	if err := l.Owned.WritePid(command.ProfileID, procs.Browser, process.Pid()); err == nil {
		err = l.Owned.WriteJSON(command.ProfileID, "launch.json", map[string]string{
			"profile_id": command.ProfileID, "user_data_dir": command.UserDataDir,
		})
		if err != nil {
			process.Kill()
			return nil, err
		}
	} else {
		process.Kill()
		return nil, err
	}
	return &browserHandle{process: process, cdpPort: command.CdpPort}, nil
}

// BrowserArgs is the CloakBrowser command line for a launch.
func BrowserArgs(command LaunchCommand, proxyURL string, diskCacheSizeMB int) []string {
	args := []string{
		"--user-data-dir=" + command.UserDataDir,
		"--disk-cache-size=" + strconv.Itoa(diskCacheSizeMB*1024*1024),
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=" + strconv.Itoa(command.CdpPort),
		"--no-sandbox",
		"--no-first-run",
		"--no-default-browser-check",
		"--window-position=0,0",
		fmt.Sprintf("--window-size=%d,%d", command.ScreenWidth, command.ScreenHeight),
		"--disable-infobars",
		"--test-type",
	}
	if command.FingerprintSeed != "" {
		args = append(args, "--fingerprint="+command.FingerprintSeed)
	}
	if command.Platform != "" {
		args = append(args, "--fingerprint-platform="+command.Platform)
	}
	if command.GPUVendor != "" {
		args = append(args, "--fingerprint-gpu-vendor="+command.GPUVendor)
	}
	if command.GPURenderer != "" {
		args = append(args, "--fingerprint-gpu-renderer="+command.GPURenderer)
	}
	args = append(args,
		"--fingerprint-hardware-concurrency="+strconv.Itoa(command.HardwareConcurrency),
		"--fingerprint-screen-width="+strconv.Itoa(command.ScreenWidth),
		"--fingerprint-screen-height="+strconv.Itoa(command.ScreenHeight),
	)
	if command.UserAgent != "" {
		args = append(args, "--user-agent="+command.UserAgent)
	}
	if command.Timezone != "" {
		args = append(args, "--fingerprint-timezone="+command.Timezone)
	}
	if command.Locale != "" {
		args = append(args, "--lang="+command.Locale, "--accept-lang="+command.Locale, "--fingerprint-locale="+command.Locale)
	}
	if command.ColorScheme != "" && command.ColorScheme != "system" {
		scheme := "1"
		if command.ColorScheme == "dark" {
			scheme = "0"
		}
		args = append(args, "--blink-settings=preferredColorScheme="+scheme)
	}
	if proxyURL != "" {
		args = append(args, "--proxy-server="+proxyURL)
	}
	if command.Headless {
		args = append(args, "--headless=new")
	} else {
		// ANGLE's software backend works on the virtual display without a host GPU.
		args = append(args, "--disable-gpu", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader")
	}
	return append(args, command.CustomLaunchArgs...)
}

func prepareLicenseHome(dataRoot, key string) (map[string]string, error) {
	// Stable across profile rotation and Hub restarts; never put the raw key in a path.
	sum := sha256.Sum256([]byte(key))
	home, err := filepath.Abs(filepath.Join(dataRoot, "license-homes", hex.EncodeToString(sum[:])))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, err
	}
	return map[string]string{
		"HOME":            home,
		"XDG_CONFIG_HOME": filepath.Join(home, ".config"),
		"XDG_CACHE_HOME":  filepath.Join(home, ".cache"),
		"XDG_DATA_HOME":   filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME":  filepath.Join(home, ".local", "state"),
	}, nil
}

type browserHandle struct {
	process *procs.Handle
	cdpPort int
}

func (h *browserHandle) Done() <-chan struct{} { return h.process.Done() }

func (h *browserHandle) ExitError() error {
	switch h.process.ExitCode() {
	case 76:
		return &CapacityError{Message: "CloakBrowser rejected the session: license concurrency limit reached"}
	case 77:
		return errors.New("CloakBrowser rejected the license: missing, invalid, or expired key")
	case 78:
		return &CapacityError{Message: "CloakBrowser license validation unavailable; retry later"}
	}
	return nil
}

// Close lets Chromium flush cookies and storage via Browser.close; SIGTERM is the fallback.
func (h *browserHandle) Close() error {
	if h.process.Exited() {
		return nil
	}
	if err := CloseBrowserOverCdp(h.cdpPort); err != nil {
		h.process.Terminate()
	}
	return nil
}

func (h *browserHandle) Kill() error {
	h.process.Kill()
	return nil
}

// CloseBrowserOverCdp sends Browser.close to the browser at cdpPort.
func CloseBrowserOverCdp(port int) error {
	client := http.Client{Timeout: time.Second}
	response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/json/version")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return errors.New("Browser CDP discovery unavailable during stop")
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&version); err != nil {
		return err
	}
	target, err := url.Parse(version.WebSocketDebuggerURL)
	if err != nil {
		return err
	}
	target.Host = "127.0.0.1:" + strconv.Itoa(port)
	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	conn, _, err := dialer.Dial(target.String(), nil)
	if err != nil {
		return errors.New("Browser close connection failed")
	}
	defer conn.Close()
	_ = conn.NetConn().SetDeadline(time.Now().Add(time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"id":1,"method":"Browser.close"}`)); err != nil {
		return err
	}
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			// The browser closes the connection as it exits.
			return nil
		}
		var reply struct {
			ID    int             `json:"id"`
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal(message, &reply) != nil {
			return errors.New("Invalid browser close response")
		}
		if reply.ID == 1 {
			if len(reply.Error) > 0 {
				return errors.New("Browser rejected close")
			}
			return nil
		}
	}
}
