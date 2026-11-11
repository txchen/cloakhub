// Package procs tracks Owned Processes: the browser, display and stream processes
// CloakHub starts per profile. Each runs in its own process group, is recorded in
// a pid file and carries environment markers naming its Data Root and profile, so
// cleanup only ever signals processes CloakHub started.
package procs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Environment markers carried by every Owned Process.
const (
	DataRootEnv  = "CLOAKHUB_DATA_ROOT"
	ProfileIDEnv = "CLOAKHUB_PROFILE_ID"
)

// Kind names an Owned Process role and its pid file.
type Kind string

// Owned Process kinds.
const (
	Browser  Kind = "browser"
	Display  Kind = "display"
	Streamer Kind = "streamer"
)

// AllKinds lists every kind.
var AllKinds = []Kind{Browser, Display, Streamer}

func (k Kind) pidFile() string { return string(k) + ".pid" }

// ResourceUsage approximates a profile's memory across its process groups.
type ResourceUsage struct {
	OwnedProcessCount int    `json:"owned_process_count"`
	RSSBytes          *int64 `json:"rss_bytes"`
}

// Registry manages pid files and cleanup under one Data Root.
type Registry struct {
	DataRoot  string
	StopGrace time.Duration
	Wait      func(time.Duration)
}

// NewRegistry returns a Registry with the default 1.5 s stop grace.
func NewRegistry(dataRoot string) *Registry {
	return &Registry{DataRoot: dataRoot, StopGrace: 1500 * time.Millisecond, Wait: time.Sleep}
}

// RuntimePath is a profile's runtime directory.
func (r *Registry) RuntimePath(profileID string) string {
	return filepath.Join(r.DataRoot, "runtime", profileID)
}

// Env returns base (os.Environ when nil) with this profile's ownership markers.
func (r *Registry) Env(profileID string, base []string) []string {
	if base == nil {
		base = os.Environ()
	}
	env := make([]string, 0, len(base)+2)
	for _, entry := range base {
		name, _, _ := strings.Cut(entry, "=")
		if name != DataRootEnv && name != ProfileIDEnv {
			env = append(env, entry)
		}
	}
	return append(env, DataRootEnv+"="+r.DataRoot, ProfileIDEnv+"="+profileID)
}

// SetEnv replaces or appends NAME=value.
func SetEnv(env []string, name, value string) []string {
	prefix := name + "="
	for i, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

// WritePid records an Owned Process.
func (r *Registry) WritePid(profileID string, kind Kind, pid int) error {
	dir := r.RuntimePath(profileID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, kind.pidFile()), []byte(fmt.Sprintf("%d\n", pid)), 0o644)
}

// WriteJSON writes runtime metadata for a profile.
func (r *Registry) WriteJSON(profileID, name string, value any) error {
	dir := r.RuntimePath(profileID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(value, "", "  ")
	return os.WriteFile(filepath.Join(dir, name), raw, 0o644)
}

// RemoveRuntimeProfile deletes a profile's runtime directory.
func (r *Registry) RemoveRuntimeProfile(profileID string) error {
	return os.RemoveAll(r.RuntimePath(profileID))
}

// OwnedProfileIDs lists profiles with pid files of the given kinds, plus (always)
// profiles named by a running process's markers.
func (r *Registry) OwnedProfileIDs(kinds []Kind) []string {
	ids := map[string]bool{}
	entries, _ := os.ReadDir(filepath.Join(r.DataRoot, "runtime"))
	for _, entry := range entries {
		if entry.IsDir() && len(r.pidFileValues(entry.Name(), kinds)) > 0 {
			ids[entry.Name()] = true
		}
	}
	for _, pid := range procPids() {
		if id := profileIDFromEnviron(environ(pid), r.DataRoot); id != "" {
			ids[id] = true
		}
	}
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	slices.Sort(result)
	return result
}

// Cleanup stops Owned Processes of the given kinds (all kinds when nil) for the
// given profiles (every owned profile when nil). Without kinds it also removes the
// profiles' runtime directories and finds unrecorded processes by their markers.
func (r *Registry) Cleanup(profileIDs []string, kinds []Kind) []string {
	if profileIDs == nil {
		profileIDs = r.OwnedProfileIDs(kinds)
	}
	var wg sync.WaitGroup
	for _, id := range profileIDs {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if pids := r.ownedPids(id, kinds); len(pids) > 0 {
				for _, pid := range pids {
					SignalGroup(pid, syscall.SIGTERM)
				}
				r.Wait(r.StopGrace)
				for _, pid := range r.ownedPids(id, kinds) {
					SignalGroup(pid, syscall.SIGKILL)
				}
			}
			if kinds == nil {
				_ = r.RemoveRuntimeProfile(id)
			}
		}(id)
	}
	wg.Wait()
	result := append([]string{}, profileIDs...)
	slices.Sort(result)
	return result
}

func (r *Registry) ownedPids(profileID string, kinds []Kind) []int {
	seen := map[int]bool{}
	var pids []int
	add := func(pid int) {
		if !seen[pid] {
			seen[pid] = true
			pids = append(pids, pid)
		}
	}
	for _, pid := range r.pidFileValues(profileID, kinds) {
		// A pid file can outlive its PID namespace (container restart); only signal a
		// process that still carries this profile's ownership marker, never the Hub.
		if pid != os.Getpid() && HasMarker(environ(pid), r.DataRoot, profileID) {
			add(pid)
		}
	}
	if kinds == nil {
		for _, pid := range procPids() {
			if HasMarker(environ(pid), r.DataRoot, profileID) {
				add(pid)
			}
		}
	}
	return pids
}

func (r *Registry) pidFileValues(profileID string, kinds []Kind) []int {
	if kinds == nil {
		kinds = AllKinds
	}
	var pids []int
	for _, kind := range kinds {
		raw, err := os.ReadFile(filepath.Join(r.RuntimePath(profileID), kind.pidFile()))
		if err != nil {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// HasMarker reports whether a NUL-separated environ names this Data Root and profile.
func HasMarker(environ, dataRoot, profileID string) bool {
	if environ == "" {
		return false
	}
	values := strings.Split(environ, "\x00")
	return slices.Contains(values, DataRootEnv+"="+dataRoot) && slices.Contains(values, ProfileIDEnv+"="+profileID)
}

func profileIDFromEnviron(environ, dataRoot string) string {
	if environ == "" {
		return ""
	}
	values := strings.Split(environ, "\x00")
	if !slices.Contains(values, DataRootEnv+"="+dataRoot) {
		return ""
	}
	for _, value := range values {
		if id, ok := strings.CutPrefix(value, ProfileIDEnv+"="); ok {
			return id
		}
	}
	return ""
}

func environ(pid int) string {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	if err != nil {
		return ""
	}
	return string(raw)
}

func procPids() []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	pids := make([]int, 0, len(entries))
	for _, entry := range entries {
		if pid, err := strconv.Atoi(entry.Name()); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// SignalGroup signals a process group, falling back to the process itself.
func SignalGroup(pid int, signal syscall.Signal) {
	if pid <= 0 {
		return
	}
	if err := syscall.Kill(-pid, signal); err != nil {
		_ = syscall.Kill(pid, signal)
	}
}

type snapshot struct {
	pid, pgid int
	rss       *int64
}

var vmRSS = regexp.MustCompile(`(?m)^VmRSS:\s+(\d+)\s+kB$`)

func processSnapshot(pid int) *snapshot {
	status, err1 := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	stat, err2 := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err1 != nil || err2 != nil {
		return nil
	}
	text := string(stat)
	start := strings.LastIndex(text, ") ")
	if start < 0 {
		return nil
	}
	fields := strings.Fields(text[start+2:])
	if len(fields) < 3 {
		return nil
	}
	pgid, err := strconv.Atoi(fields[2])
	if err != nil || pgid <= 0 {
		return nil
	}
	s := &snapshot{pid: pid, pgid: pgid}
	if match := vmRSS.FindSubmatch(status); match != nil {
		kb, _ := strconv.ParseInt(string(match[1]), 10, 64)
		bytes := kb * 1024
		s.rss = &bytes
	}
	return s
}

// ResourceUsageByProfile sums RSS over the process groups rooted at each profile's
// marked pid files.
func (r *Registry) ResourceUsageByProfile(profileIDs []string) map[string]ResourceUsage {
	usage := make(map[string]ResourceUsage, len(profileIDs))
	groups := map[int]string{}
	for _, id := range profileIDs {
		usage[id] = ResourceUsage{}
		for _, pid := range r.pidFileValues(id, nil) {
			if !HasMarker(environ(pid), r.DataRoot, id) {
				continue
			}
			if s := processSnapshot(pid); s != nil {
				groups[s.pgid] = id
			}
		}
	}
	if len(groups) == 0 {
		return usage
	}
	for _, pid := range procPids() {
		s := processSnapshot(pid)
		if s == nil {
			continue
		}
		id, ok := groups[s.pgid]
		if !ok {
			continue
		}
		u := usage[id]
		u.OwnedProcessCount++
		if s.rss != nil {
			total := *s.rss
			if u.RSSBytes != nil {
				total += *u.RSSBytes
			}
			u.RSSBytes = &total
		}
		usage[id] = u
	}
	return usage
}

// Handle supervises one Owned Process started with Start.
type Handle struct {
	cmd    *exec.Cmd
	done   chan struct{}
	mu     sync.Mutex
	status *os.ProcessState
}

// Start runs cmd in a new session (its own process group) and reaps it.
func Start(cmd *exec.Cmd) (*Handle, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setsid = true
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	h := &Handle{cmd: cmd, done: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		h.mu.Lock()
		h.status = cmd.ProcessState
		h.mu.Unlock()
		close(h.done)
	}()
	return h, nil
}

// Pid is the process (and process group) ID.
func (h *Handle) Pid() int { return h.cmd.Process.Pid }

// Done closes when the process has exited and been reaped.
func (h *Handle) Done() <-chan struct{} { return h.done }

// Exited reports whether the process has exited.
func (h *Handle) Exited() bool {
	select {
	case <-h.done:
		return true
	default:
		return false
	}
}

// ExitCode is the exit status, or -1 while running or when killed by a signal.
func (h *Handle) ExitCode() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.status == nil {
		return -1
	}
	return h.status.ExitCode()
}

// Terminate sends SIGTERM to the process group.
func (h *Handle) Terminate() { SignalGroup(h.Pid(), syscall.SIGTERM) }

// Kill sends SIGKILL to the process group.
func (h *Handle) Kill() { SignalGroup(h.Pid(), syscall.SIGKILL) }

// ErrNotExecutable means a configured binary is missing or not executable.
var ErrNotExecutable = errors.New("not executable")

// IsExecutable reports whether path is an executable regular file.
func IsExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}
