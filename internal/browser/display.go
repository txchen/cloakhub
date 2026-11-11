package browser

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/viewer"
)

// DisplayBins locates Xvfb and voxl.
type DisplayBins struct {
	Xvfb, Voxl string
	Warning    string
}

// ResolveDisplayBins finds Xvfb and voxl from overrides, packaged paths and PATH.
func ResolveDisplayBins(xvfbOverride, voxlOverride, pathEnv string) DisplayBins {
	if pathEnv == "" {
		pathEnv = os.Getenv("PATH")
	}
	first := func(override, packaged, name string) string {
		candidates := []string{override, packaged}
		for _, dir := range filepath.SplitList(pathEnv) {
			if dir != "" {
				candidates = append(candidates, filepath.Join(dir, name))
			}
		}
		for _, candidate := range candidates {
			if candidate != "" && procs.IsExecutable(candidate) {
				return candidate
			}
		}
		return ""
	}
	bins := DisplayBins{
		Xvfb: first(xvfbOverride, "/usr/bin/Xvfb", "Xvfb"),
		Voxl: first(voxlOverride, "/usr/local/bin/voxl", "voxl"),
	}
	if bins.Xvfb == "" || bins.Voxl == "" {
		bins.Warning = "Missing Xvfb or voxl display runtime. Headed Browser Instances will fail until both are installed."
	}
	return bins
}

// VoxlDisplayRuntime runs one private Xvfb display per headed instance, streamed by
// its own voxl process. They are separate Owned Processes so the encoder can
// restart (new settings, crash) without taking the browser's display down.
type VoxlDisplayRuntime struct {
	XvfbBin, VoxlBin string
	Owned            *procs.Registry
	Settings         func() viewer.Settings
	// XRoot holds .X<n>-lock and .X11-unix/; /tmp except in tests.
	XRoot string
	// Command builds processes; tests replace it.
	Command func(name string, args ...string) *exec.Cmd
	// WaitForDisplay waits for Xvfb to accept connections; tests replace it.
	WaitForDisplay func(displayNumber int, xvfb *procs.Handle) error

	mu   sync.Mutex
	live map[string]*liveDisplay
}

type liveDisplay struct {
	mu        sync.Mutex
	command   DisplayCommand
	stopping  bool
	xvfb      *procs.Handle
	streamer  *procs.Handle
	restarted map[*procs.Handle]bool
}

const streamerRespawnDelay = time.Second

func (d *VoxlDisplayRuntime) xRoot() string {
	if d.XRoot == "" {
		return "/tmp"
	}
	return d.XRoot
}

func (d *VoxlDisplayRuntime) command(name string, args ...string) *exec.Cmd {
	if d.Command != nil {
		return d.Command(name, args...)
	}
	return exec.Command(name, args...)
}

// Start launches the display and its streamer.
func (d *VoxlDisplayRuntime) Start(command DisplayCommand) (ProcessHandle, error) {
	if d.XvfbBin == "" || d.VoxlBin == "" {
		return nil, &MissingDisplayError{}
	}
	d.Owned.Cleanup([]string{command.ProfileID}, []procs.Kind{procs.Display, procs.Streamer})
	if err := clearStaleDisplay(d.xRoot(), command.DisplayNumber); err != nil {
		return nil, err
	}
	cmd := d.command(d.XvfbBin, XvfbArgs(command)...)
	cmd.Env = d.Owned.Env(command.ProfileID, nil)
	cmd.Stderr = os.Stderr
	xvfb, err := procs.Start(cmd)
	if err != nil {
		return nil, err
	}
	display := &liveDisplay{command: command, xvfb: xvfb, restarted: map[*procs.Handle]bool{}}
	handle := &displayHandle{display: display, onStop: func() {
		d.mu.Lock()
		if d.live[command.ProfileID] == display {
			delete(d.live, command.ProfileID)
		}
		d.mu.Unlock()
	}}
	fail := func(err error) (ProcessHandle, error) {
		_ = handle.Kill()
		return nil, err
	}
	if err := d.Owned.WritePid(command.ProfileID, procs.Display, xvfb.Pid()); err != nil {
		return fail(err)
	}
	wait := d.WaitForDisplay
	if wait == nil {
		wait = func(n int, x *procs.Handle) error { return waitForXSocket(d.xRoot(), n, x) }
	}
	if err := wait(command.DisplayNumber, xvfb); err != nil {
		return fail(err)
	}
	if err := d.startStreamer(display); err != nil {
		return fail(err)
	}
	d.mu.Lock()
	if d.live == nil {
		d.live = map[string]*liveDisplay{}
	}
	d.live[command.ProfileID] = display
	d.mu.Unlock()
	return handle, nil
}

func (d *VoxlDisplayRuntime) startStreamer(display *liveDisplay) error {
	command := display.command
	settings := viewer.Default
	if d.Settings != nil {
		settings = d.Settings()
	}
	cmd := d.command(d.VoxlBin, StreamerArgs(command, settings)...)
	env := d.Owned.Env(command.ProfileID, nil)
	env = procs.SetEnv(env, "DISPLAY", ":"+strconv.Itoa(command.DisplayNumber))
	logLevel := os.Getenv("CLOAKHUB_VOXL_LOG")
	if logLevel == "" {
		logLevel = "warn"
	}
	cmd.Env = procs.SetEnv(env, "RUST_LOG", logLevel)
	cmd.Stderr = os.Stderr
	streamer, err := procs.Start(cmd)
	if err != nil {
		return err
	}
	display.mu.Lock()
	display.streamer = streamer
	display.mu.Unlock()
	if err := d.Owned.WritePid(command.ProfileID, procs.Streamer, streamer.Pid()); err != nil {
		return err
	}
	go func() {
		<-streamer.Done()
		// Respawn an encoder that went away while its display still runs: at once
		// after RestartStreams, after a pause if it crashed.
		current := func() bool {
			display.mu.Lock()
			defer display.mu.Unlock()
			return !display.stopping && display.streamer == streamer && !display.xvfb.Exited()
		}
		if !current() {
			return
		}
		display.mu.Lock()
		delay := streamerRespawnDelay
		if display.restarted[streamer] {
			delay = 0
			delete(display.restarted, streamer)
		}
		display.mu.Unlock()
		time.Sleep(delay)
		if current() {
			if err := d.startStreamer(display); err != nil {
				log.Printf("voxl restart failed for %s: %v", command.ProfileID, err)
			}
		}
	}()
	return nil
}

// RestartStreams restarts every running streamer with the current settings.
func (d *VoxlDisplayRuntime) RestartStreams() {
	d.mu.Lock()
	displays := make([]*liveDisplay, 0, len(d.live))
	for _, display := range d.live {
		displays = append(displays, display)
	}
	d.mu.Unlock()
	for _, display := range displays {
		display.mu.Lock()
		streamer := display.streamer
		if streamer != nil && !display.stopping {
			display.restarted[streamer] = true
		}
		display.mu.Unlock()
		if streamer != nil {
			streamer.Terminate()
		}
	}
}

type displayHandle struct {
	display *liveDisplay
	onStop  func()
	once    sync.Once
	done    chan struct{}
	doneMu  sync.Mutex
}

func (h *displayHandle) processes() []*procs.Handle {
	h.display.mu.Lock()
	defer h.display.mu.Unlock()
	result := []*procs.Handle{}
	if h.display.streamer != nil {
		result = append(result, h.display.streamer)
	}
	return append(result, h.display.xvfb)
}

func (h *displayHandle) stop() {
	h.display.mu.Lock()
	h.display.stopping = true
	h.display.mu.Unlock()
	h.onStop()
}

func (h *displayHandle) Close() error {
	h.stop()
	for _, p := range h.processes() {
		p.Terminate()
	}
	return nil
}

func (h *displayHandle) Kill() error {
	h.stop()
	for _, p := range h.processes() {
		p.Kill()
	}
	return nil
}

// Done closes once the display and its current streamer have exited.
func (h *displayHandle) Done() <-chan struct{} {
	h.doneMu.Lock()
	defer h.doneMu.Unlock()
	if h.done == nil {
		h.done = make(chan struct{})
		go func() {
			<-h.display.xvfb.Done()
			for {
				h.display.mu.Lock()
				streamer := h.display.streamer
				h.display.mu.Unlock()
				if streamer == nil {
					break
				}
				<-streamer.Done()
				h.display.mu.Lock()
				same := h.display.streamer == streamer
				h.display.mu.Unlock()
				if same {
					break
				}
			}
			close(h.done)
		}()
	}
	return h.done
}

func (h *displayHandle) ExitError() error { return nil }

// XvfbArgs is the Xvfb command line for a display.
func XvfbArgs(command DisplayCommand) []string {
	return []string{
		":" + strconv.Itoa(command.DisplayNumber),
		"-screen", "0", fmt.Sprintf("%dx%dx24", command.ScreenWidth, command.ScreenHeight),
		"-dpi", "96",
		"-nolisten", "tcp",
		"-ac",
		// Shared-memory framebuffer: voxl captures it without copying.
		"-shmem",
		"-noreset",
		// CloakBrowser renders with its bundled SwiftShader; the image omits Mesa.
		"-extension", "GLX",
	}
}

// StreamerArgs is the voxl command line for a display.
func StreamerArgs(command DisplayCommand, settings viewer.Settings) []string {
	clipboard := "false"
	if command.ClipboardSync {
		clipboard = "true"
	}
	args := []string{
		"--addr=127.0.0.1",
		"--port=" + strconv.Itoa(command.ViewerPort),
		"--enable-basic-auth=false",
		"--title=CloakHub Viewer",
		"--enable-clipboard=" + clipboard,
		"--enable-resize=false",
		"--audio-enabled=false",
		"--microphone-enabled=false",
		"--file-transfers=none",
	}
	return append(args, viewer.VoxlFlags(settings)...)
}

// clearStaleDisplay removes a lock and socket left by an X server that no longer runs.
func clearStaleDisplay(xRoot string, displayNumber int) error {
	lock := filepath.Join(xRoot, fmt.Sprintf(".X%d-lock", displayNumber))
	if raw, err := os.ReadFile(lock); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 0 && isXServer(pid) {
			return fmt.Errorf("Display :%d is already in use by process %d", displayNumber, pid)
		}
	}
	_ = os.Remove(lock)
	_ = os.Remove(filepath.Join(xRoot, ".X11-unix", fmt.Sprintf("X%d", displayNumber)))
	return nil
}

func isXServer(pid int) bool {
	comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	return err == nil && strings.HasPrefix(strings.TrimSpace(string(comm)), "X")
}

func waitForXSocket(xRoot string, displayNumber int, xvfb *procs.Handle) error {
	socket := filepath.Join(xRoot, ".X11-unix", fmt.Sprintf("X%d", displayNumber))
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if xvfb.Exited() {
			return fmt.Errorf("Xvfb :%d exited during startup (code %d)", displayNumber, xvfb.ExitCode())
		}
		if info, err := os.Stat(socket); err == nil && info.Mode()&os.ModeSocket != 0 {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("Xvfb :%d did not start within 10 seconds", displayNumber)
}
