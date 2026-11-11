// Command uifixture serves the real CloakHub HTTP app with a fake browser runtime
// for the Playwright UI tests (tests/ui). No browser or display is launched.
package main

import (
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/config"
	"github.com/txchen/cloakhub/internal/events"
	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/profile"
	"github.com/txchen/cloakhub/internal/web"
)

type fakeHandle struct {
	once sync.Once
	done chan struct{}
}

func newFakeHandle() *fakeHandle            { return &fakeHandle{done: make(chan struct{})} }
func (h *fakeHandle) stop()                 { h.once.Do(func() { close(h.done) }) }
func (h *fakeHandle) Close() error          { h.stop(); return nil }
func (h *fakeHandle) Kill() error           { h.stop(); return nil }
func (h *fakeHandle) Done() <-chan struct{} { return h.done }
func (h *fakeHandle) ExitError() error      { return nil }

type fakeLauncher struct{}

func (fakeLauncher) Launch(browser.LaunchCommand) (browser.ProcessHandle, error) {
	return newFakeHandle(), nil
}

type fakeDisplay struct{}

func (fakeDisplay) Start(browser.DisplayCommand) (browser.ProcessHandle, error) {
	return newFakeHandle(), nil
}

func main() {
	dataRoot, err := os.MkdirTemp("", "cloakhub-ui-tests-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dataRoot)
	eventLog, err := events.Open(dataRoot)
	if err != nil {
		log.Fatal(err)
	}
	repository, err := profile.OpenRepository(dataRoot)
	if err != nil {
		log.Fatal(err)
	}
	if err := repository.Migrate(); err != nil {
		log.Fatal(err)
	}
	profiles, err := profile.NewService(profile.ServiceOptions{
		DataRoot: dataRoot, Repository: repository,
		CreationRegion: profile.Region{Timezone: "Asia/Tokyo", Locale: "ja-JP"},
	})
	if err != nil {
		log.Fatal(err)
	}
	owned := procs.NewRegistry(dataRoot)
	ready := func(browser.State) error { return nil }
	runtime := browser.New(browser.Options{
		BrowserBin: "fixture", Events: eventLog, DataRoot: dataRoot, Repository: repository,
		Launcher: fakeLauncher{}, DisplayRuntime: fakeDisplay{},
		ReadinessProbe: ready, ViewerReadinessProbe: ready, Owned: owned,
	})
	cfg := config.Config{DataRoot: dataRoot, Host: "127.0.0.1", Port: 17790, MaxRunningInstances: 10, LicenseMode: "required"}
	app := web.New(cfg, web.Services{Events: eventLog, Runtime: runtime, Profiles: profiles, Owned: owned})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /__test/cdp/work", func(w http.ResponseWriter, r *http.Request) {
		if _, err := runtime.OpenCdpSession("work", "", ""); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", app)
	server := &http.Server{Addr: "127.0.0.1:17790", Handler: mux}
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
		<-signals
		_ = runtime.Shutdown()
		_ = server.Close()
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	repository.Close()
	eventLog.Close()
}
