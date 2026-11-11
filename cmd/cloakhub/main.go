// Command cloakhub runs the CloakHub server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/cdp"
	"github.com/txchen/cloakhub/internal/config"
	"github.com/txchen/cloakhub/internal/events"
	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/profile"
	"github.com/txchen/cloakhub/internal/viewer"
	"github.com/txchen/cloakhub/internal/web"
)

func main() {
	log.SetFlags(0)
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	home, _ := os.UserHomeDir()
	cfg, err := config.Load(nil, home)
	if err != nil {
		return err
	}
	if cfg.MacOSFontconfigFile != "" {
		if _, err := os.Stat(cfg.MacOSFontconfigFile); err != nil {
			return errors.New("CLOAKHUB_MACOS_FONTCONFIG_FILE must point to an existing fontconfig file")
		}
	}
	if err := ensureDataRoot(cfg.DataRoot); err != nil {
		return err
	}
	if os.Getenv("CLOAKHUB_BROWSER_INSTALLER") != "" {
		return errors.New("CLOAKHUB_BROWSER_INSTALLER is no longer supported; mount a CloakBrowser binary and set CLOAKHUB_BROWSER_BIN")
	}
	browserBin, err := resolveBrowserBin(cfg.BrowserBin)
	if err != nil {
		return err
	}

	var licensePool *browser.LicensePool
	maxRunning := cfg.MaxRunningInstances
	if cfg.LicenseMode == "none" {
		// In free mode never read license configuration or reserve licensed slots.
		log.Printf("CLOAKHUB_LICENSE_MODE=none: CloakBrowser license checks disabled; Hub limit %d", maxRunning)
	} else {
		keys, err := browser.LoadLicenseKeys(nil, home)
		if err != nil {
			return err
		}
		if len(keys) > 0 {
			if licensePool, err = browser.NewLicensePool(keys, nil); err != nil {
				return err
			}
			maxRunning = min(maxRunning, licensePool.Capacity)
			log.Printf("CloakBrowser: %d configured key(s), %d licensed slots; Hub limit %d", len(keys), licensePool.Capacity, maxRunning)
		}
	}

	displayBins := browser.ResolveDisplayBins(os.Getenv("CLOAKHUB_XVFB_BIN"), os.Getenv("CLOAKHUB_VOXL_BIN"), "")
	if displayBins.Warning != "" {
		log.Print(displayBins.Warning)
	}
	eventLog, err := events.Open(cfg.DataRoot)
	if err != nil {
		return err
	}
	repository, err := profile.OpenRepository(cfg.DataRoot)
	if err != nil {
		return err
	}
	if err := repository.Migrate(); err != nil {
		return err
	}
	profiles, err := profile.NewService(profile.ServiceOptions{
		CreationPlatform: cfg.CreationPlatform,
		CreationRegion:   cfg.CreationRegion,
		DataRoot:         cfg.DataRoot,
		Repository:       repository,
	})
	if err != nil {
		return err
	}
	owned := procs.NewRegistry(cfg.DataRoot)
	display := &browser.VoxlDisplayRuntime{XvfbBin: displayBins.Xvfb, VoxlBin: displayBins.Voxl, Owned: owned}
	viewerSettings := viewer.Open(cfg.DataRoot, func(viewer.Settings) { display.RestartStreams() })
	display.Settings = viewerSettings.Get

	launcher := browser.NewProcessLauncher(cfg.DataRoot, cfg.DiskCacheSizeMB, cfg.MacOSFontconfigFile, licensePool)
	launcher.Owned = owned
	runtime := browser.New(browser.Options{
		BrowserBin:          browserBin,
		Events:              eventLog,
		ClipboardReader:     browser.CdpClipboardReader{},
		ClipboardWriter:     browser.XclipWriter{},
		DataRoot:            cfg.DataRoot,
		DisplayRuntime:      display,
		Launcher:            launcher,
		MaxRunningInstances: maxRunning,
		Owned:               owned,
		Repository:          repository,
	})
	runtime.CleanupOnStartup()

	gateway := &cdp.Gateway{Runtime: runtime, Profiles: profiles}
	relay := &cdp.Relay{
		Sessions: sessionTracker{runtime},
		Guard: &cdp.TabGuard{OnBlankTab: func(profileID string) {
			id := profileID
			eventLog.Record(events.Input{ProfileID: &id, Type: "tab.protected", Message: "Created an empty tab before closing the last tab."})
		}},
	}
	server := web.New(cfg, web.Services{
		Events: eventLog, Viewer: viewerSettings, Runtime: runtime, Gateway: gateway,
		Relay: relay, Profiles: profiles, Owned: owned,
	})

	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: server, ReadHeaderTimeout: 30 * time.Second}
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	idle := time.NewTicker(5 * time.Second)
	go func() {
		for range idle.C {
			runtime.SpinDownIdle()
		}
	}()
	eventLog.Record(events.Input{Type: "hub.started", Message: "CloakHub started; idle checks run every 5 seconds."})
	log.Printf("CloakHub listening on http://%s:%d", cfg.Host, cfg.Port)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	received := <-signals
	log.Printf("CloakHub received %s; shutting down Browser Instances", signalName(received))
	idle.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Hijacked WebSockets are not tracked by Shutdown; runtime shutdown closes them.
	_ = httpServer.Shutdown(ctx)
	shutdownErr := runtime.Shutdown()
	repository.Close()
	eventLog.Close()
	return shutdownErr
}

func signalName(sig os.Signal) string {
	if s, ok := sig.(syscall.Signal); ok {
		switch s {
		case syscall.SIGTERM:
			return "SIGTERM"
		case syscall.SIGINT:
			return "SIGINT"
		}
	}
	return sig.String()
}

type sessionTracker struct{ runtime *browser.Runtime }

func (t sessionTracker) OpenCdpSession(profileID, remoteAddress, userAgent string) (cdp.Session, error) {
	return t.runtime.OpenCdpSession(profileID, remoteAddress, userAgent)
}

func ensureDataRoot(dataRoot string) error {
	fail := func(err error) error {
		return fmt.Errorf("Data Root %q is unusable: %v", dataRoot, err)
	}
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		return fail(err)
	}
	info, err := os.Stat(dataRoot)
	if err != nil {
		return fail(err)
	}
	if !info.IsDir() {
		return fail(errors.New("path is not a directory"))
	}
	probe := filepath.Join(dataRoot, fmt.Sprintf(".cloakhub-write-test-%d-%d", os.Getpid(), time.Now().UnixNano()))
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return fail(err)
	}
	return os.Remove(probe)
}

func resolveBrowserBin(configured string) (string, error) {
	if configured != "" && !procs.IsExecutable(configured) {
		return "", errors.New("Configured CLOAKHUB_BROWSER_BIN is missing or not executable")
	}
	candidates := []string{configured, "/opt/cloakbrowser/cloakbrowser"}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir != "" {
			candidates = append(candidates, filepath.Join(dir, "cloakbrowser"))
		}
	}
	for _, candidate := range candidates {
		if candidate != "" && procs.IsExecutable(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("Missing CloakBrowser Binary. Set CLOAKHUB_BROWSER_BIN or install cloakbrowser on PATH.")
}
