package browser

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/txchen/cloakhub/internal/events"
	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/profile"
)

type fakeHandle struct {
	once     sync.Once
	done     chan struct{}
	closes   atomic.Int32
	kills    atomic.Int32
	ignoreUp bool // ignore Close (forces the kill path)
}

func newFakeHandle() *fakeHandle { return &fakeHandle{done: make(chan struct{})} }
func (h *fakeHandle) exit()      { h.once.Do(func() { close(h.done) }) }
func (h *fakeHandle) Close() error {
	h.closes.Add(1)
	if !h.ignoreUp {
		h.exit()
	}
	return nil
}
func (h *fakeHandle) Kill() error           { h.kills.Add(1); h.exit(); return nil }
func (h *fakeHandle) Done() <-chan struct{} { return h.done }

type fakeLauncher struct {
	mu       sync.Mutex
	commands []LaunchCommand
	handles  []*fakeHandle
	err      error
	delay    time.Duration
}

func (l *fakeLauncher) Launch(command LaunchCommand) (ProcessHandle, error) {
	if l.delay > 0 {
		time.Sleep(l.delay)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.err != nil {
		return nil, l.err
	}
	h := newFakeHandle()
	l.commands = append(l.commands, command)
	l.handles = append(l.handles, h)
	return h, nil
}

func (l *fakeLauncher) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.commands)
}

type fakeDisplay struct {
	mu       sync.Mutex
	commands []DisplayCommand
	handles  []*fakeHandle
}

func (d *fakeDisplay) Start(command DisplayCommand) (ProcessHandle, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	h := newFakeHandle()
	d.commands = append(d.commands, command)
	d.handles = append(d.handles, h)
	return h, nil
}

type recorder struct {
	mu     sync.Mutex
	events []events.Input
}

func (r *recorder) Record(e events.Input) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *recorder) types(profileID string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []string
	for _, e := range r.events {
		if e.ProfileID != nil && *e.ProfileID == profileID {
			result = append(result, e.Type)
		}
	}
	return result
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type fixture struct {
	runtime  *Runtime
	repo     *profile.Repository
	launcher *fakeLauncher
	display  *fakeDisplay
	events   *recorder
	clock    *clock
}

func newFixture(t *testing.T, configure func(*Options)) *fixture {
	t.Helper()
	dataRoot := t.TempDir()
	repo, err := profile.OpenRepository(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Migrate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { repo.Close() })
	f := &fixture{repo: repo, launcher: &fakeLauncher{}, display: &fakeDisplay{}, events: &recorder{},
		clock: &clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}}
	ready := func(State) error { return nil }
	owned := procs.NewRegistry(dataRoot)
	owned.Wait = func(time.Duration) {}
	options := Options{
		BrowserBin: "/opt/cloakbrowser/chrome", Events: f.events, DataRoot: dataRoot, Repository: repo,
		Launcher: f.launcher, DisplayRuntime: f.display, ReadinessProbe: ready, ViewerReadinessProbe: ready,
		Now: f.clock.Now, Owned: owned, StopGrace: 20 * time.Millisecond,
	}
	if configure != nil {
		configure(&options)
	}
	f.runtime = New(options)
	return f
}

func (f *fixture) create(t *testing.T, id string, mutate func(*profile.LaunchFields)) {
	t.Helper()
	launch := profile.DefaultLaunchFields()
	launch.FingerprintSeed = "12345"
	if mutate != nil {
		mutate(&launch)
	}
	if _, err := f.repo.Create(profile.CreateInput{ProfileID: id, Launch: launch}); err != nil {
		t.Fatal(err)
	}
}

func headless(l *profile.LaunchFields) { l.Headless = true }

func TestStartsHeadlessWithPrivateCdpAndPersistentData(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", headless)
	state, err := f.runtime.Start("work")
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != "running" || state.CdpPort != 5100 || state.Display != "" {
		t.Errorf("state %+v", state)
	}
	command := f.launcher.commands[0]
	if !command.Headless || !strings.HasSuffix(command.UserDataDir, "/profiles/work") || command.FingerprintSeed != "12345" {
		t.Errorf("command %+v", command)
	}
	if p := f.repo.Get("work"); p.InstanceStatus != "running" || p.LastStartedAt == nil || p.LastActivityAt == nil {
		t.Errorf("profile %+v", p)
	}
	if len(f.display.commands) != 0 {
		t.Error("headless started a display")
	}
	// A second start returns the running state without relaunching.
	if again, _ := f.runtime.Start("work"); again.CdpPort != 5100 || f.launcher.count() != 1 {
		t.Errorf("restart on start: %+v %d", again, f.launcher.count())
	}
}

func TestHeadedStartsDisplayAndViewer(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", nil)
	viewer, err := f.runtime.OpenManualViewer("work")
	if err != nil {
		t.Fatal(err)
	}
	if viewer.Display != ":100" || viewer.ViewerPort != 5900 || viewer.DisplayPath != "/ui/profiles/work/display/" || !viewer.ClipboardSync {
		t.Errorf("viewer %+v", viewer)
	}
	display := f.display.commands[0]
	if display.DisplayNumber != 100 || display.ScreenWidth != 1366 || display.ScreenHeight != 768 || display.ViewerPort != 5900 {
		t.Errorf("display %+v", display)
	}
	if f.launcher.commands[0].Display != ":100" {
		t.Errorf("browser display %q", f.launcher.commands[0].Display)
	}
}

func TestHeadedLaunchFailsClearlyWithoutDisplayRuntime(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.DisplayRuntime = nil })
	f.create(t, "work", nil)
	_, err := f.runtime.Start("work")
	var missing *MissingDisplayError
	if !errors.As(err, &missing) {
		t.Fatalf("got %v", err)
	}
	p := f.repo.Get("work")
	if p.InstanceStatus != "failed" || *p.LastLaunchError != "Missing Xvfb or voxl display runtime" {
		t.Errorf("profile %+v", p)
	}
}

func TestHeadlessProfilesHaveNoViewer(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", headless)
	var unsupported *UnsupportedViewerError
	if _, err := f.runtime.OpenManualViewer("work"); !errors.As(err, &unsupported) {
		t.Errorf("got %v", err)
	}
	var notFound *profile.NotFoundError
	if _, err := f.runtime.Start("missing"); !errors.As(err, &notFound) {
		t.Errorf("got %v", err)
	}
}

func TestReadinessFailureStopsProcessesAndRecordsLaunchFailure(t *testing.T) {
	f := newFixture(t, func(o *Options) {
		o.ReadinessProbe = func(State) error { return errors.New("CDP endpoint was not ready") }
	})
	f.create(t, "work", nil)
	if _, err := f.runtime.Start("work"); err == nil {
		t.Fatal("start succeeded")
	}
	if f.launcher.handles[0].closes.Load() == 0 || f.display.handles[0].closes.Load() == 0 {
		t.Error("processes not stopped")
	}
	p := f.repo.Get("work")
	if p.InstanceStatus != "failed" || *p.LastStopReason != "launch failure" || !strings.Contains(*p.LastLaunchError, "not ready") {
		t.Errorf("profile %+v", p)
	}
	// Recovery: a later start succeeds and reuses the released ports.
	f.runtime.opts.ReadinessProbe = func(State) error { return nil }
	if state, err := f.runtime.Start("work"); err != nil || state.CdpPort != 5101 {
		t.Errorf("recovery %+v %v", state, err)
	}
	if p := f.repo.Get("work"); *p.LastLaunchError == "" {
		t.Error("prior launch error lost")
	}
}

func TestBrowserExitBeforeReadyIsALaunchFailure(t *testing.T) {
	f := newFixture(t, func(o *Options) {
		o.ReadinessProbe = func(State) error { time.Sleep(time.Second); return nil }
	})
	f.create(t, "work", headless)
	go func() {
		for f.launcher.count() == 0 {
			time.Sleep(time.Millisecond)
		}
		f.launcher.handles[0].exit()
	}()
	if _, err := f.runtime.Start("work"); err == nil || err.Error() != "Browser exited before CDP was ready" {
		t.Fatalf("got %v", err)
	}
	if p := f.repo.Get("work"); p.InstanceStatus != "failed" || *p.LastStopReason != "launch failure" {
		t.Errorf("profile %+v", p)
	}
}

func TestConcurrentStartsShareOneLaunch(t *testing.T) {
	f := newFixture(t, nil)
	f.launcher.delay = 50 * time.Millisecond
	f.create(t, "work", headless)
	var wg sync.WaitGroup
	states := make([]State, 5)
	for i := range states {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			states[i], _ = f.runtime.Start("work")
		}(i)
	}
	wg.Wait()
	if f.launcher.count() != 1 {
		t.Errorf("launched %d times", f.launcher.count())
	}
	for _, s := range states {
		if s.CdpPort != 5100 {
			t.Errorf("state %+v", s)
		}
	}
}

func TestStopClosesThenKillsAndRecordsHistory(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", nil)
	if _, err := f.runtime.Start("work"); err != nil {
		t.Fatal(err)
	}
	f.launcher.handles[0].ignoreUp = true
	state, err := f.runtime.Stop("work", profile.StopManual)
	if err != nil || state.Status != "stopped" {
		t.Fatalf("%+v %v", state, err)
	}
	if f.launcher.handles[0].kills.Load() != 1 || f.display.handles[0].closes.Load() != 1 {
		t.Error("expected graceful close then kill for the browser, close for the display")
	}
	p := f.repo.Get("work")
	if p.InstanceStatus != "stopped" || *p.LastStopReason != "manual stop" {
		t.Errorf("profile %+v", p)
	}
	got := strings.Join(f.events.types("work"), ",")
	if !strings.Contains(got, "browser.starting,browser.started,browser.stopping,browser.stopped") {
		t.Errorf("events %s", got)
	}
}

func TestExplicitStopOverridesActiveClients(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", headless)
	f.runtime.Start("work")
	session, _ := f.runtime.OpenCdpSession("work", "10.0.0.1", "playwright")
	if f.runtime.ActiveCdpSessionCount("work") != 1 {
		t.Fatal("session not counted")
	}
	f.runtime.Stop("work", profile.StopManual)
	if f.runtime.ActiveCdpSessionCount("work") != 0 {
		t.Error("stop kept the session")
	}
	session.Close()
	session.Close()
}

func TestCrashIsRecordedAndReleasesResources(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", nil)
	f.runtime.Start("work")
	f.runtime.OpenViewerSession("work")
	f.launcher.handles[0].exit()
	deadline := time.Now().Add(2 * time.Second)
	for f.repo.Get("work").InstanceStatus != "stopped" && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	p := f.repo.Get("work")
	if p.InstanceStatus != "stopped" || *p.LastStopReason != "crash" || f.runtime.ActiveViewerCount("work") != 0 {
		t.Errorf("profile %+v viewers %d", p, f.runtime.ActiveViewerCount("work"))
	}
	if f.display.handles[0].closes.Load() == 0 {
		t.Error("display left running after crash")
	}
}

func TestCdpSessionsAndObservations(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", headless)
	a, _ := f.runtime.OpenCdpSession("work", "10.0.0.1", "agent")
	f.clock.Advance(90 * time.Second)
	observations := f.runtime.CdpSessionObservations("work")
	if len(observations) != 1 || observations[0].DurationMs != 90000 || *observations[0].RemoteAddress != "10.0.0.1" || *observations[0].UserAgent != "agent" {
		t.Errorf("observations %+v", observations)
	}
	a.Close()
	if f.runtime.ActiveCdpSessionCount("work") != 0 {
		t.Error("session not closed")
	}
	if _, err := f.runtime.OpenCdpSession("missing", "", ""); err == nil {
		t.Error("session for missing profile")
	}
}

func TestManualInputIsThrottled(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", nil)
	viewer, _ := f.runtime.OpenViewerSession("work")
	viewer.RecordInput()
	first := *f.repo.Get("work").LastManualInputAt
	f.clock.Advance(2 * time.Second)
	viewer.RecordInput()
	if *f.repo.Get("work").LastManualInputAt != first {
		t.Error("input within 5 s was recorded")
	}
	f.clock.Advance(4 * time.Second)
	viewer.RecordInput()
	if *f.repo.Get("work").LastManualInputAt == first {
		t.Error("input after 5 s was not recorded")
	}
	if f.runtime.ActiveViewerCount("work") != 1 {
		t.Error("viewer presence")
	}
	viewer.Close()
	if f.runtime.ActiveViewerCount("work") != 0 {
		t.Error("viewer not closed")
	}
}

func TestIdleSpinDown(t *testing.T) {
	f := newFixture(t, nil)
	minutes := 5
	f.create(t, "idle", func(l *profile.LaunchFields) {
		l.Headless = true
		l.SleepPolicy = profile.SleepPolicy{Mode: "minutes", Minutes: &minutes}
	})
	f.create(t, "never", func(l *profile.LaunchFields) {
		l.Headless = true
		l.SleepPolicy = profile.SleepPolicy{Mode: "never"}
	})
	f.create(t, "busy", headless)
	f.create(t, "viewed", nil)
	for _, id := range []string{"idle", "never", "busy", "viewed"} {
		if _, err := f.runtime.Start(id); err != nil {
			t.Fatal(err)
		}
	}
	f.runtime.OpenCdpSession("busy", "", "")
	f.runtime.OpenViewerSession("viewed")
	if results := f.runtime.SpinDownIdle(); len(results) != 0 {
		t.Errorf("stopped early: %+v", results)
	}
	f.clock.Advance(31 * time.Minute)
	results := f.runtime.SpinDownIdle()
	stopped := map[string]bool{}
	for _, r := range results {
		stopped[r.ProfileID] = true
	}
	if !stopped["idle"] || !stopped["viewed"] || stopped["never"] || stopped["busy"] {
		t.Errorf("results %+v", results)
	}
	if *f.repo.Get("idle").LastStopReason != "idle timeout" {
		t.Error("reason")
	}
	events := strings.Join(f.events.types("busy"), ",")
	if !strings.Contains(events, "sleep.blocked") {
		t.Errorf("busy events %s", events)
	}
	if !strings.Contains(strings.Join(f.events.types("idle"), ","), "sleep.timeout") {
		t.Error("timeout event")
	}
}

func TestCapacityPreemptsLeastRecentlyActiveEligibleInstance(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.MaxRunningInstances = 2 })
	for _, id := range []string{"a", "b", "c"} {
		f.create(t, id, headless)
	}
	f.runtime.Start("a")
	f.clock.Advance(time.Minute)
	f.runtime.Start("b")
	f.clock.Advance(time.Minute)
	if _, err := f.runtime.Start("c"); err != nil {
		t.Fatal(err)
	}
	if p := f.repo.Get("a"); p.InstanceStatus != "stopped" || *p.LastStopReason != "capacity preemption" {
		t.Errorf("a %+v", p)
	}
	// CDP sessions and recent manual input protect instances.
	f.runtime.OpenCdpSession("b", "", "")
	f.runtime.recordManualInput("c")
	var capacity *CapacityError
	if _, err := f.runtime.Start("a"); !errors.As(err, &capacity) {
		t.Errorf("expected capacity error, got %v", err)
	}
	f.clock.Advance(61 * time.Second)
	if _, err := f.runtime.Start("a"); err != nil {
		t.Errorf("manual input protection should expire: %v", err)
	}
	if f.repo.Get("c").InstanceStatus != "stopped" {
		t.Error("c should have been preempted")
	}
}

func TestConcurrentStartsRespectTheLimit(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.MaxRunningInstances = 2 })
	f.launcher.delay = 30 * time.Millisecond
	for _, id := range []string{"a", "b", "c", "d"} {
		f.create(t, id, headless)
	}
	var wg sync.WaitGroup
	var failures atomic.Int32
	for _, id := range []string{"a", "b", "c", "d"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if _, err := f.runtime.Start(id); err != nil {
				failures.Add(1)
			}
		}(id)
	}
	wg.Wait()
	running := 0
	for _, id := range []string{"a", "b", "c", "d"} {
		if f.repo.Get(id).InstanceStatus == "running" {
			running++
		}
	}
	if running > 2 {
		t.Errorf("%d running over the limit", running)
	}
}

func TestRestartAndDelete(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", headless)
	f.runtime.Start("work")
	if state, err := f.runtime.Restart("work"); err != nil || state.Status != "running" || f.launcher.count() != 2 {
		t.Fatalf("%+v %v", state, err)
	}
	removed := false
	if err := f.runtime.DeleteProfile("work", func() error { removed = true; return nil }); err != nil || !removed {
		t.Fatalf("delete: %v", err)
	}
	if f.repo.Get("work").InstanceStatus != "stopped" {
		t.Error("delete did not stop")
	}
	// Deletion data failures surface, and the browser stays stopped.
	f.runtime.Start("work")
	if err := f.runtime.DeleteProfile("work", func() error { return errors.New("disk") }); err == nil {
		t.Error("expected removal error")
	}
}

func TestShutdownStopsInstancesAndRefusesStarts(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "a", headless)
	f.create(t, "b", nil)
	f.runtime.Start("a")
	f.runtime.Start("b")
	if err := f.runtime.Shutdown(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if p := f.repo.Get(id); p.InstanceStatus != "stopped" || *p.LastStopReason != "shutdown" {
			t.Errorf("%s %+v", id, p)
		}
	}
	if _, err := f.runtime.Start("a"); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("start after shutdown: %v", err)
	}
}

func TestClipboardRequiresSyncAndARunningDisplay(t *testing.T) {
	writer := &fakeWriter{}
	f := newFixture(t, func(o *Options) { o.ClipboardWriter = writer })
	f.create(t, "work", nil)
	f.create(t, "off", func(l *profile.LaunchFields) { l.ClipboardSync = false })
	if err := f.runtime.WriteManualClipboard("work", "hi"); err == nil {
		t.Error("write without a running display")
	}
	f.runtime.Start("work")
	if err := f.runtime.WriteManualClipboard("work", "hi"); err != nil || writer.display != ":100" || writer.text != "hi" {
		t.Errorf("write %v %+v", err, writer)
	}
	if err := f.runtime.WriteManualClipboard("off", "hi"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Errorf("disabled sync: %v", err)
	}
	if _, err := f.runtime.ReadManualClipboard("off"); err == nil {
		t.Error("read with sync disabled")
	}
}

type fakeWriter struct{ display, text string }

func (w *fakeWriter) WriteText(display, text string) error {
	w.display, w.text = display, text
	return nil
}

func TestStartupCleanupMarksProfilesStopped(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", nil)
	f.repo.MarkRunning("work", "2026-01-01T00:00:00.000Z")
	f.runtime.CleanupOnStartup()
	if p := f.repo.Get("work"); p.InstanceStatus != "stopped" || *p.LastStopReason != "restart" {
		t.Errorf("%+v", p)
	}
}

func TestCustomLaunchArgsAreRevalidatedBeforeLaunch(t *testing.T) {
	f := newFixture(t, nil)
	f.create(t, "work", func(l *profile.LaunchFields) {
		l.Headless = true
		l.CustomLaunchArgs = []string{"--remote-debugging-port=1"}
	})
	if _, err := f.runtime.Start("work"); err == nil || f.launcher.count() != 0 {
		t.Errorf("launched with an owned flag: %v", err)
	}
}
