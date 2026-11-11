// Package browser supervises Browser Instances: launching CloakBrowser with its
// display and stream processes, capacity, idle sleep, crash handling and shutdown.
package browser

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/txchen/cloakhub/internal/events"
	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/profile"
)

// ProcessHandle controls a launched browser or display.
type ProcessHandle interface {
	// Close asks the process to exit gracefully.
	Close() error
	// Kill force-stops the process group.
	Kill() error
	// Done closes once every process has exited.
	Done() <-chan struct{}
	// ExitError explains a recognized abnormal exit, or nil.
	ExitError() error
}

// LaunchCommand is everything needed to launch CloakBrowser.
type LaunchCommand struct {
	BrowserBin          string
	CdpPort             int
	CustomLaunchArgs    []string
	Timezone            string
	Locale              string
	ColorScheme         string
	Display             string
	FingerprintSeed     string
	GPURenderer         string
	GPUVendor           string
	HardwareConcurrency int
	Headless            bool
	Platform            string
	ProfileID           string
	Proxy               string
	ScreenHeight        int
	ScreenWidth         int
	UserAgent           string
	UserDataDir         string
}

// Launcher starts CloakBrowser.
type Launcher interface {
	Launch(LaunchCommand) (ProcessHandle, error)
}

// DisplayCommand describes one private display and its stream.
type DisplayCommand struct {
	ClipboardSync bool
	DisplayNumber int
	ProfileID     string
	ScreenHeight  int
	ScreenWidth   int
	ViewerPort    int
}

// DisplayRuntime starts a display for a headed instance.
type DisplayRuntime interface {
	Start(DisplayCommand) (ProcessHandle, error)
}

// ClipboardReader reads the browser's copied text over CDP.
type ClipboardReader interface {
	ReadText(cdpPort int) (string, error)
}

// ClipboardWriter writes the display's X clipboard.
type ClipboardWriter interface {
	WriteText(display, text string) error
}

// ClientConnections disconnects a profile's external clients on stop.
type ClientConnections interface {
	Disconnect(profileID, reason string)
}

// State is a Browser Instance's lifecycle state.
type State struct {
	CdpPort    int    `json:"cdp_port"`
	Display    string `json:"display,omitempty"`
	ProfileID  string `json:"profile_id"`
	Status     string `json:"status"`
	ViewerPort int    `json:"viewer_port,omitempty"`
}

// ViewerState locates a running instance's viewer.
type ViewerState struct {
	ClipboardSync bool   `json:"clipboard_sync"`
	Display       string `json:"display"`
	ProfileID     string `json:"profile_id"`
	ViewerPort    int    `json:"viewer_port"`
	DisplayPath   string `json:"display_path"`
}

// CdpSessionObservation describes one open CDP session.
type CdpSessionObservation struct {
	DurationMs    int64   `json:"duration_ms"`
	RemoteAddress *string `json:"remote_address"`
	StartedAt     string  `json:"started_at"`
	UserAgent     *string `json:"user_agent"`
}

// Errors.
var (
	ErrShuttingDown = errors.New("CloakHub is shutting down")
)

// UnsupportedViewerError means the profile is headless.
type UnsupportedViewerError struct{ ProfileID string }

func (e *UnsupportedViewerError) Error() string {
	return fmt.Sprintf("Manual viewer is unavailable for headless Browser Profiles. Edit the profile to disable headless mode before opening the viewer for %q.", e.ProfileID)
}

// MissingDisplayError means Xvfb or voxl is not installed.
type MissingDisplayError struct{}

func (e *MissingDisplayError) Error() string { return "Missing Xvfb or voxl display runtime" }

// Options configure a Runtime.
type Options struct {
	BrowserBin           string
	Events               events.Recorder
	ClipboardReader      ClipboardReader
	ClipboardWriter      ClipboardWriter
	CdpPortStart         int
	ClientConnections    ClientConnections
	DataRoot             string
	DisplayNumberStart   int
	DisplayRuntime       DisplayRuntime
	Launcher             Launcher
	ReadinessProbe       func(State) error
	ViewerReadinessProbe func(State) error
	MaxRunningInstances  int
	Now                  func() time.Time
	Owned                *procs.Registry
	Repository           *profile.Repository
	StopGrace            time.Duration
	ViewerPortStart      int
}

type runningInstance struct {
	cdpPort       int
	display       string
	displayNumber int
	viewerPort    int
	displayHandle ProcessHandle
	handle        ProcessHandle
}

type cdpSession struct {
	id            int
	started       time.Time
	startedWall   string
	remoteAddress string
	userAgent     string
}

type operation struct {
	kind  string
	done  chan struct{}
	state State
	err   error
}

const (
	manualInputActivityThrottle = 5 * time.Second
	readyTimeout                = 5 * time.Second
	readyPoll                   = 100 * time.Millisecond
)

// Runtime is the in-memory supervisor of Browser Instances.
type Runtime struct {
	opts     Options
	repo     *profile.Repository
	capacity *Capacity
	now      func() time.Time

	mu                sync.Mutex
	running           map[string]*runningInstance
	operations        map[string]*operation
	cdpSessions       map[string][]cdpSession
	viewers           map[string][]int
	lastActivity      map[string]time.Time
	manualRecorded    map[string]time.Time
	manualObserved    map[string]time.Time
	sleepObservations map[string]string
	shuttingDown      bool
	nextSessionID     int
	nextViewerID      int
}

// New returns a Runtime.
func New(options Options) *Runtime {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Owned == nil {
		options.Owned = procs.NewRegistry(options.DataRoot)
	}
	if options.ReadinessProbe == nil {
		options.ReadinessProbe = CdpReadinessProbe
	}
	if options.ViewerReadinessProbe == nil {
		options.ViewerReadinessProbe = ViewerReadinessProbe
	}
	if options.StopGrace == 0 {
		options.StopGrace = 1500 * time.Millisecond
	}
	return &Runtime{
		opts: options,
		repo: options.Repository,
		capacity: NewCapacity(CapacityOptions{
			CdpPortStart:        options.CdpPortStart,
			DisplayNumberStart:  options.DisplayNumberStart,
			ViewerPortStart:     options.ViewerPortStart,
			MaxRunningInstances: options.MaxRunningInstances,
			Now:                 options.Now,
		}),
		now:               options.Now,
		running:           map[string]*runningInstance{},
		operations:        map[string]*operation{},
		cdpSessions:       map[string][]cdpSession{},
		viewers:           map[string][]int{},
		lastActivity:      map[string]time.Time{},
		manualRecorded:    map[string]time.Time{},
		manualObserved:    map[string]time.Time{},
		sleepObservations: map[string]string{},
		nextSessionID:     1,
		nextViewerID:      1,
	}
}

func (r *Runtime) nowISO() string { return profile.NowISO(r.now()) }

func (r *Runtime) log(profileID, kind, message string, details map[string]any, level string) {
	if r.opts.Events == nil {
		return
	}
	id := profileID
	r.opts.Events.Record(events.Input{ProfileID: &id, Type: kind, Message: message, Details: details, Level: level, OccurredAt: r.nowISO()})
}

func (r *Runtime) require(profileID string) (*profile.Profile, error) {
	p := r.repo.Get(profileID)
	if p == nil {
		return nil, &profile.NotFoundError{ProfileID: profileID}
	}
	return p, nil
}

// ActiveCdpSessionCount is the number of open external CDP sessions.
func (r *Runtime) ActiveCdpSessionCount(profileID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.cdpSessions[profileID])
}

// ActiveViewerCount is the number of open viewer streams.
func (r *Runtime) ActiveViewerCount(profileID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.viewers[profileID])
}

// CdpSessionObservations describes the open CDP sessions.
func (r *Runtime) CdpSessionObservations(profileID string) []CdpSessionObservation {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := []CdpSessionObservation{}
	for _, s := range r.cdpSessions[profileID] {
		o := CdpSessionObservation{DurationMs: r.now().Sub(s.started).Milliseconds(), StartedAt: s.startedWall}
		if s.remoteAddress != "" {
			address := s.remoteAddress
			o.RemoteAddress = &address
		}
		if s.userAgent != "" {
			agent := s.userAgent
			o.UserAgent = &agent
		}
		result = append(result, o)
	}
	return result
}

// LastManualInputAt is the persisted time of the last Manual Input.
func (r *Runtime) LastManualInputAt(profileID string) *string {
	if p := r.repo.Get(profileID); p != nil {
		return p.LastManualInputAt
	}
	return nil
}

// CleanupOnStartup stops leftover Owned Processes and marks profiles stopped.
func (r *Runtime) CleanupOnStartup() {
	r.opts.Owned.Cleanup(nil, nil)
	for _, p := range r.repo.List() {
		if p.InstanceStatus != profile.StatusStopped {
			r.log(p.ProfileID, "browser.stopped", "Stopped during CloakHub startup cleanup.", map[string]any{"reason": "restart"}, "")
		}
	}
	r.repo.MarkAllStopped(profile.StopRestart, r.nowISO())
}

// CdpSession is an open external CDP connection.
type CdpSession struct {
	runtime   *Runtime
	profileID string
	id        int
	once      sync.Once
}

// Close ends the session.
func (s *CdpSession) Close() {
	s.once.Do(func() {
		r := s.runtime
		r.mu.Lock()
		sessions := r.cdpSessions[s.profileID]
		next := make([]cdpSession, 0, len(sessions))
		for _, entry := range sessions {
			if entry.id != s.id {
				next = append(next, entry)
			}
		}
		if len(next) == 0 {
			delete(r.cdpSessions, s.profileID)
		} else {
			r.cdpSessions[s.profileID] = next
		}
		r.mu.Unlock()
		r.log(s.profileID, "cdp.disconnected", "CDP client disconnected.", map[string]any{"connections": len(next)}, "")
	})
}

// RecordMessage records a CDP message as Instance Activity.
func (s *CdpSession) RecordMessage() { s.runtime.recordActivity(s.profileID) }

// OpenCdpSession registers an external CDP connection, which blocks idle sleep.
func (r *Runtime) OpenCdpSession(profileID, remoteAddress, userAgent string) (*CdpSession, error) {
	if _, err := r.require(profileID); err != nil {
		return nil, err
	}
	r.mu.Lock()
	id := r.nextSessionID
	r.nextSessionID++
	r.cdpSessions[profileID] = append(r.cdpSessions[profileID], cdpSession{
		id: id, started: r.now(), startedWall: r.nowISO(), remoteAddress: remoteAddress, userAgent: userAgent,
	})
	count := len(r.cdpSessions[profileID])
	r.mu.Unlock()
	r.recordActivity(profileID)
	r.log(profileID, "cdp.connected", "CDP client connected; automatic sleep is blocked.", map[string]any{"connections": count}, "")
	return &CdpSession{runtime: r, profileID: profileID, id: id}, nil
}

// ViewerSession is an open viewer stream.
type ViewerSession struct {
	runtime   *Runtime
	profileID string
	id        int
	once      sync.Once
}

// Close ends the viewer session.
func (v *ViewerSession) Close() {
	v.once.Do(func() {
		r := v.runtime
		r.mu.Lock()
		defer r.mu.Unlock()
		ids := r.viewers[v.profileID]
		next := make([]int, 0, len(ids))
		for _, id := range ids {
			if id != v.id {
				next = append(next, id)
			}
		}
		if len(next) == 0 {
			delete(r.viewers, v.profileID)
		} else {
			r.viewers[v.profileID] = next
		}
	})
}

// RecordInput records Manual Input through the viewer.
func (v *ViewerSession) RecordInput() { v.runtime.recordManualInput(v.profileID) }

// OpenManualViewer starts a headed profile if needed and waits for its viewer.
func (r *Runtime) OpenManualViewer(profileID string) (ViewerState, error) {
	p, err := r.require(profileID)
	if err != nil {
		return ViewerState{}, err
	}
	if p.Headless {
		return ViewerState{}, &UnsupportedViewerError{ProfileID: p.ProfileID}
	}
	state, err := r.Start(profileID)
	if err != nil {
		return ViewerState{}, err
	}
	if state.Display == "" || state.ViewerPort == 0 {
		return ViewerState{}, fmt.Errorf("Browser Profile %q did not expose a manual viewer endpoint", profileID)
	}
	if err := r.opts.ViewerReadinessProbe(state); err != nil {
		return ViewerState{}, err
	}
	return ViewerState{
		Display:       state.Display,
		ProfileID:     p.ProfileID,
		ViewerPort:    state.ViewerPort,
		ClipboardSync: p.ClipboardSync,
		DisplayPath:   "/ui/profiles/" + pathEscape(p.ProfileID) + "/display/",
	}, nil
}

// OpenViewerSession registers a viewer stream connection.
func (r *Runtime) OpenViewerSession(profileID string) (*ViewerSession, error) {
	p, err := r.require(profileID)
	if err != nil {
		return nil, err
	}
	if p.Headless {
		return nil, &UnsupportedViewerError{ProfileID: p.ProfileID}
	}
	r.mu.Lock()
	id := r.nextViewerID
	r.nextViewerID++
	r.viewers[profileID] = append(r.viewers[profileID], id)
	r.mu.Unlock()
	return &ViewerSession{runtime: r, profileID: profileID, id: id}, nil
}

// RecordCdpDiscovery records CDP discovery as Instance Activity.
func (r *Runtime) RecordCdpDiscovery(profileID string) error {
	if _, err := r.require(profileID); err != nil {
		return err
	}
	r.recordActivity(profileID)
	return nil
}

func (r *Runtime) clipboardTarget(profileID string) (*profile.Profile, *runningInstance, error) {
	p, err := r.require(profileID)
	if err != nil {
		return nil, nil, err
	}
	if p.Headless {
		return nil, nil, &UnsupportedViewerError{ProfileID: p.ProfileID}
	}
	if !p.ClipboardSync {
		return nil, nil, errors.New("Clipboard sync is disabled for this profile")
	}
	r.mu.Lock()
	running := r.running[profileID]
	r.mu.Unlock()
	return p, running, nil
}

// ReadManualClipboard returns the browser's copied text.
func (r *Runtime) ReadManualClipboard(profileID string) (string, error) {
	_, running, err := r.clipboardTarget(profileID)
	if err != nil {
		return "", err
	}
	if running == nil {
		return "", fmt.Errorf("Browser Profile %q is not running", profileID)
	}
	if r.opts.ClipboardReader == nil {
		return "", errors.New("Manual clipboard reader is unavailable")
	}
	return r.opts.ClipboardReader.ReadText(running.cdpPort)
}

// WriteManualClipboard sets the display's clipboard text.
func (r *Runtime) WriteManualClipboard(profileID, text string) error {
	_, running, err := r.clipboardTarget(profileID)
	if err != nil {
		return err
	}
	if running == nil || running.display == "" {
		return fmt.Errorf("Browser Profile %q does not have a running manual viewer display", profileID)
	}
	if r.opts.ClipboardWriter == nil {
		return errors.New("Manual clipboard writer is unavailable")
	}
	return r.opts.ClipboardWriter.WriteText(running.display, text)
}

func (r *Runtime) assertAcceptingStarts() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.shuttingDown {
		return ErrShuttingDown
	}
	return nil
}

// serialize runs action after any pending operation on the same profile.
func (r *Runtime) serialize(profileID, kind string, action func() (State, error)) (State, error) {
	r.mu.Lock()
	previous := r.operations[profileID]
	op := &operation{kind: kind, done: make(chan struct{})}
	r.operations[profileID] = op
	r.mu.Unlock()
	if previous != nil {
		<-previous.done
	}
	op.state, op.err = action()
	r.mu.Lock()
	if r.operations[profileID] == op {
		delete(r.operations, profileID)
	}
	r.mu.Unlock()
	close(op.done)
	return op.state, op.err
}

// Start launches a profile, or returns its running state.
func (r *Runtime) Start(profileID string) (State, error) {
	if err := r.assertAcceptingStarts(); err != nil {
		return State{}, err
	}
	r.mu.Lock()
	if pending := r.operations[profileID]; pending != nil && pending.kind == "start" {
		r.mu.Unlock()
		<-pending.done
		return pending.state, pending.err
	}
	r.mu.Unlock()
	return r.serialize(profileID, "start", func() (State, error) {
		p, err := r.require(profileID)
		if err != nil {
			return State{}, err
		}
		r.mu.Lock()
		running := r.running[profileID]
		r.mu.Unlock()
		if running != nil && p.InstanceStatus == profile.StatusRunning {
			return runningState(profileID, running), nil
		}
		// A previous cleanup failure retains ownership; retry cleanup before reusing its ports.
		if running != nil {
			if _, err := r.stopProfile(p, profile.StopLaunchFailure, false); err != nil {
				return State{}, err
			}
		}
		if p, err = r.require(profileID); err != nil {
			return State{}, err
		}
		return r.launch(p)
	})
}

// Stop stops a profile.
func (r *Runtime) Stop(profileID, reason string) (State, error) {
	return r.serialize(profileID, "stop", func() (State, error) {
		p, err := r.require(profileID)
		if err != nil {
			return State{}, err
		}
		return r.stopProfile(p, reason, true)
	})
}

// Restart stops then starts a profile.
func (r *Runtime) Restart(profileID string) (State, error) {
	if err := r.assertAcceptingStarts(); err != nil {
		return State{}, err
	}
	return r.serialize(profileID, "restart", func() (State, error) {
		p, err := r.require(profileID)
		if err != nil {
			return State{}, err
		}
		if _, err := r.stopProfile(p, profile.StopRestart, true); err != nil {
			return State{}, err
		}
		if p, err = r.require(profileID); err != nil {
			return State{}, err
		}
		return r.launch(p)
	})
}

// DeleteProfile stops a profile, then removes its data with removeData.
func (r *Runtime) DeleteProfile(profileID string, removeData func() error) error {
	_, err := r.serialize(profileID, "delete", func() (State, error) {
		p, err := r.require(profileID)
		if err != nil {
			return State{}, err
		}
		if _, err := r.stopProfile(p, profile.StopManual, false); err != nil {
			return State{}, err
		}
		if err := removeData(); err != nil {
			return State{}, err
		}
		r.mu.Lock()
		delete(r.lastActivity, profileID)
		delete(r.manualRecorded, profileID)
		delete(r.manualObserved, profileID)
		r.mu.Unlock()
		return State{}, nil
	})
	return err
}

// Shutdown stops every instance and refuses new starts.
func (r *Runtime) Shutdown() error {
	r.mu.Lock()
	r.shuttingDown = true
	ids := map[string]bool{}
	for id := range r.running {
		ids[id] = true
	}
	for id := range r.operations {
		ids[id] = true
	}
	r.mu.Unlock()
	var wg sync.WaitGroup
	var failure error
	var failureMu sync.Mutex
	for id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := r.serialize(id, "shutdown", func() (State, error) {
				if p := r.repo.Get(id); p != nil {
					return r.stopProfile(p, profile.StopShutdown, false)
				}
				return State{}, nil
			})
			if err != nil {
				failureMu.Lock()
				if failure == nil {
					failure = err
				}
				failureMu.Unlock()
			}
		}(id)
	}
	wg.Wait()
	r.opts.Owned.Cleanup(nil, nil)
	r.repo.MarkAllStopped(profile.StopShutdown, r.nowISO())
	return failure
}

func (r *Runtime) launch(p *profile.Profile) (State, error) {
	reservation, err := r.capacity.Reserve(p, r.capacitySnapshots, func(candidate *profile.Profile) error {
		_, err := r.serialize(candidate.ProfileID, "preempt", func() (State, error) {
			return r.stopProfile(candidate, profile.StopCapacityPreemption, false)
		})
		return err
	})
	if err != nil {
		return State{}, err
	}
	r.repo.MarkStarting(p.ProfileID)
	r.log(p.ProfileID, "browser.starting", "Browser is starting.", nil, "")
	resources := &runningInstance{
		cdpPort:       reservation.CdpPort,
		display:       reservation.Display,
		displayNumber: reservation.DisplayNumber,
		viewerPort:    reservation.ViewerPort,
	}
	r.mu.Lock()
	r.running[p.ProfileID] = resources
	r.mu.Unlock()

	fail := func(err error) (State, error) {
		if cleanupErr := r.releaseResources(p.ProfileID, resources); cleanupErr != nil {
			err = fmt.Errorf("%v; cleanup failed: %v", err, cleanupErr)
		}
		r.log(p.ProfileID, "browser.start_failed", "Browser failed to start. Check the profile launch error.", nil, "error")
		r.repo.MarkLaunchFailed(p.ProfileID, err.Error(), r.nowISO())
		return State{}, err
	}

	if err := profile.ValidateProfileSettings(p); err != nil {
		return fail(err)
	}
	if err := profile.ValidateCustomLaunchArgs(p.CustomLaunchArgs); err != nil {
		return fail(err)
	}
	if !p.Headless {
		if r.opts.DisplayRuntime == nil || reservation.DisplayNumber == 0 || reservation.ViewerPort == 0 {
			return fail(&MissingDisplayError{})
		}
		handle, err := r.opts.DisplayRuntime.Start(DisplayCommand{
			ClipboardSync: p.ClipboardSync,
			DisplayNumber: reservation.DisplayNumber,
			ProfileID:     p.ProfileID,
			ScreenHeight:  p.ScreenHeight,
			ScreenWidth:   p.ScreenWidth,
			ViewerPort:    reservation.ViewerPort,
		})
		if err != nil {
			return fail(err)
		}
		resources.displayHandle = handle
	}
	handle, err := r.opts.Launcher.Launch(LaunchCommand{
		BrowserBin:          r.opts.BrowserBin,
		CdpPort:             reservation.CdpPort,
		CustomLaunchArgs:    p.CustomLaunchArgs,
		Timezone:            p.Timezone,
		Locale:              p.Locale,
		ColorScheme:         p.ColorScheme,
		Display:             reservation.Display,
		FingerprintSeed:     p.FingerprintSeed,
		GPURenderer:         p.GPURenderer,
		GPUVendor:           p.GPUVendor,
		HardwareConcurrency: p.HardwareConcurrency,
		Headless:            p.Headless,
		Platform:            p.Platform,
		ProfileID:           p.ProfileID,
		Proxy:               p.Proxy,
		ScreenHeight:        p.ScreenHeight,
		ScreenWidth:         p.ScreenWidth,
		UserAgent:           p.UserAgent,
		UserDataDir:         filepath.Join(r.opts.DataRoot, "profiles", p.ProfileID),
	})
	if err != nil {
		return fail(err)
	}
	resources.handle = handle
	state := runningState(p.ProfileID, resources)
	ready := make(chan error, 1)
	go func() { ready <- r.opts.ReadinessProbe(state) }()
	select {
	case err := <-ready:
		if err != nil {
			return fail(err)
		}
	case <-handle.Done():
		if exitErr := handle.ExitError(); exitErr != nil {
			return fail(exitErr)
		}
		return fail(errors.New("Browser exited before CDP was ready"))
	}
	r.superviseExit(p.ProfileID, handle)
	occurredAt := r.nowISO()
	r.repo.MarkRunning(p.ProfileID, occurredAt)
	r.recordActivityAt(p.ProfileID, occurredAt)
	r.mu.Lock()
	delete(r.sleepObservations, p.ProfileID)
	r.mu.Unlock()
	r.log(p.ProfileID, "browser.started", "Browser started.", map[string]any{"idle_minutes": p.SleepPolicyStatus.EffectiveMinutes}, "")
	return state, nil
}

// releaseResources stops every process of an instance and frees its reservation
// only once all of them have exited.
func (r *Runtime) releaseResources(profileID string, resources *runningInstance) error {
	var errs []error
	// Close the browser first so it flushes its profile before its display goes away.
	for _, handle := range []ProcessHandle{resources.handle, resources.displayHandle} {
		if handle == nil {
			continue
		}
		_ = handle.Close()
		select {
		case <-handle.Done():
			continue
		case <-time.After(r.opts.StopGrace):
		}
		_ = handle.Kill()
		select {
		case <-handle.Done():
		case <-time.After(5 * time.Second):
			errs = append(errs, errors.New("Process did not exit after forced stop"))
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("Could not stop all instance processes: %w", errors.Join(errs...))
	}
	r.mu.Lock()
	if r.running[profileID] == resources {
		delete(r.running, profileID)
	}
	r.mu.Unlock()
	r.capacity.Release(profileID)
	return nil
}

func (r *Runtime) stopProfile(p *profile.Profile, reason string, recordActivity bool) (State, error) {
	r.mu.Lock()
	running := r.running[p.ProfileID]
	r.mu.Unlock()
	r.repo.MarkStopping(p.ProfileID)
	r.log(p.ProfileID, "browser.stopping", "Browser is stopping.", map[string]any{"reason": reason}, "")
	if recordActivity {
		r.recordActivity(p.ProfileID)
	}
	if r.opts.ClientConnections != nil {
		r.opts.ClientConnections.Disconnect(p.ProfileID, reason)
	}
	r.mu.Lock()
	delete(r.cdpSessions, p.ProfileID)
	delete(r.viewers, p.ProfileID)
	r.mu.Unlock()
	if running != nil {
		if err := r.releaseResources(p.ProfileID, running); err != nil {
			r.log(p.ProfileID, "browser.stop_failed", "Browser cleanup failed; stop has not completed.", map[string]any{"reason": reason}, "error")
			return State{}, err
		}
	} else {
		r.capacity.Release(p.ProfileID)
	}
	r.repo.MarkStopped(p.ProfileID, reason, r.nowISO())
	r.mu.Lock()
	delete(r.sleepObservations, p.ProfileID)
	r.mu.Unlock()
	level := ""
	if reason == profile.StopCrash {
		level = "warning"
	}
	r.log(p.ProfileID, "browser.stopped", "Browser stopped.", map[string]any{"reason": reason}, level)
	cdpPort := -1
	if running != nil {
		cdpPort = running.cdpPort
	}
	return State{CdpPort: cdpPort, ProfileID: p.ProfileID, Status: profile.StatusStopped}, nil
}

func (r *Runtime) superviseExit(profileID string, handle ProcessHandle) {
	go func() {
		<-handle.Done()
		_, err := r.serialize(profileID, "crash", func() (State, error) {
			r.mu.Lock()
			current := r.running[profileID]
			r.mu.Unlock()
			if current == nil || current.handle != handle {
				return State{}, nil
			}
			p, err := r.require(profileID)
			if err != nil {
				return State{}, err
			}
			if _, err := r.stopProfile(p, profile.StopCrash, false); err != nil {
				return State{}, err
			}
			if exitErr := handle.ExitError(); exitErr != nil {
				r.repo.MarkFailed(profileID, exitErr.Error(), r.nowISO())
			}
			return State{}, nil
		})
		if err != nil && r.repo.Get(profileID) != nil {
			r.repo.MarkFailed(profileID, err.Error(), r.nowISO())
		}
	}()
}

// IdleResult is one instance stopped for idleness.
type IdleResult struct {
	ProfileID string `json:"profile_id"`
	Reason    string `json:"reason"`
}

// SpinDownIdle stops instances whose Sleep Policy timeout has elapsed.
func (r *Runtime) SpinDownIdle() []IdleResult {
	r.mu.Lock()
	ids := make([]string, 0, len(r.running))
	for id := range r.running {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	results := []IdleResult{}
	for _, id := range ids {
		p := r.repo.Get(id)
		r.mu.Lock()
		_, busy := r.operations[id]
		lastActivity, hasActivity := r.lastActivity[id]
		connections := len(r.cdpSessions[id])
		r.mu.Unlock()
		if p == nil || busy {
			continue
		}
		minutes := p.SleepPolicyStatus.EffectiveMinutes
		var idleMs *int64
		if hasActivity {
			ms := max(0, r.now().Sub(lastActivity).Milliseconds())
			idleMs = &ms
		}
		blocker := ""
		if p.SleepPolicyStatus.BlocksSleep || minutes == nil {
			blocker = "never-sleep policy"
		} else if connections > 0 {
			blocker = "active CDP connections"
		}
		observationJSON, _ := json.Marshal([]any{nullableString(blocker), minutes, connections})
		observation := string(observationJSON)
		r.mu.Lock()
		changed := r.sleepObservations[id] != observation
		if changed {
			r.sleepObservations[id] = observation
		}
		r.mu.Unlock()
		details := map[string]any{"idle_minutes": minutes, "connections": connections, "last_activity_at": p.LastActivityAt, "idle_ms": idleMs}
		if changed {
			if blocker != "" {
				r.log(id, "sleep.blocked", "Automatic sleep blocked by "+blocker+".", details, "")
			} else {
				r.log(id, "sleep.countdown", "Automatic sleep countdown is active.", details, "")
			}
		}
		if blocker != "" || minutes == nil || idleMs == nil || *idleMs < int64(*minutes)*60_000 {
			continue
		}
		r.log(id, "sleep.timeout", "Idle timeout reached; stopping browser.", map[string]any{
			"idle_minutes": minutes, "idle_ms": idleMs, "last_activity_at": p.LastActivityAt, "connections": connections,
		}, "")
		if _, err := r.serialize(id, "idle", func() (State, error) {
			return r.stopProfile(p, profile.StopIdleTimeout, false)
		}); err == nil {
			results = append(results, IdleResult{ProfileID: id, Reason: "idle timeout"})
		}
	}
	return results
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (r *Runtime) recordActivity(profileID string) { r.recordActivityAt(profileID, r.nowISO()) }

func (r *Runtime) recordActivityAt(profileID, occurredAt string) {
	r.mu.Lock()
	r.lastActivity[profileID] = r.now()
	r.mu.Unlock()
	r.repo.RecordActivity(profileID, occurredAt)
}

func (r *Runtime) recordManualInput(profileID string) {
	current := r.now()
	r.mu.Lock()
	r.manualObserved[profileID] = current
	if last, ok := r.manualRecorded[profileID]; ok && current.Sub(last) < manualInputActivityThrottle {
		r.mu.Unlock()
		return
	}
	r.manualRecorded[profileID] = current
	r.lastActivity[profileID] = current
	r.mu.Unlock()
	r.repo.RecordManualInput(profileID, profile.NowISO(current))
	r.log(profileID, "sleep.activity", "Manual input reset the idle countdown.", map[string]any{"source": "manual input"}, "")
}

func (r *Runtime) capacitySnapshots() []RunningSnapshot {
	r.mu.Lock()
	type entry struct {
		id      string
		running *runningInstance
	}
	var entries []entry
	for id, running := range r.running {
		if _, busy := r.operations[id]; !busy {
			entries = append(entries, entry{id, running})
		}
	}
	r.mu.Unlock()
	var snapshots []RunningSnapshot
	for _, e := range entries {
		p := r.repo.Get(e.id)
		if p == nil || p.InstanceStatus != profile.StatusRunning {
			continue
		}
		r.mu.Lock()
		snapshot := RunningSnapshot{
			ActiveCdpSessions: len(r.cdpSessions[e.id]),
			CdpPort:           e.running.cdpPort,
			DisplayNumber:     e.running.displayNumber,
			ViewerPort:        e.running.viewerPort,
			LastActivity:      r.lastActivity[e.id],
			LastManualInput:   r.manualObserved[e.id],
			Profile:           p,
		}
		r.mu.Unlock()
		snapshots = append(snapshots, snapshot)
	}
	return snapshots
}

func runningState(profileID string, running *runningInstance) State {
	return State{
		CdpPort:    running.cdpPort,
		Display:    running.display,
		ProfileID:  profileID,
		Status:     profile.StatusRunning,
		ViewerPort: running.viewerPort,
	}
}

// CdpReadinessProbe waits for the browser's private CDP endpoint.
func CdpReadinessProbe(state State) error {
	client := http.Client{Timeout: time.Second}
	deadline := time.Now().Add(readyTimeout)
	last := "not ready"
	for !time.Now().After(deadline) {
		response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(state.CdpPort) + "/json/version")
		if err == nil {
			response.Body.Close()
			if response.StatusCode < 300 {
				return nil
			}
			last = "returned " + strconv.Itoa(response.StatusCode)
		} else {
			last = err.Error()
		}
		time.Sleep(readyPoll)
	}
	return fmt.Errorf("Browser Instance CDP endpoint was not ready: %s", last)
}

// ViewerReadinessProbe waits for the viewer stream port to accept connections.
func ViewerReadinessProbe(state State) error {
	if state.ViewerPort == 0 {
		return errors.New("Browser Instance viewer endpoint was not allocated")
	}
	deadline := time.Now().Add(readyTimeout)
	last := "not ready"
	for !time.Now().After(deadline) {
		conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(state.ViewerPort), time.Second)
		if err == nil {
			conn.Close()
			return nil
		}
		last = err.Error()
		time.Sleep(readyPoll)
	}
	return fmt.Errorf("Browser Instance viewer endpoint was not ready: %s", last)
}

func itoa(value int) string { return strconv.Itoa(value) }

func pathEscape(value string) string { return url.PathEscape(value) }
