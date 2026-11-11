// Package config loads CloakHub settings from the environment.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/txchen/cloakhub/internal/profile"
)

// Defaults and fixed internal resource ranges.
const (
	DefaultDiskCacheSizeMB     = 256
	DefaultHost                = "127.0.0.1"
	DefaultPort                = 7788
	DefaultMaxRunningInstances = 10
)

// Range is an inclusive integer range.
type Range struct{ Start, End int }

// Size is the number of values in the range.
func (r Range) Size() int { return r.End - r.Start + 1 }

// Internal port and display ranges used by Browser Instances.
var (
	CdpPortRange       = Range{5100, 5199}
	DisplayNumberRange = Range{100, 199}
	ViewerPortRange    = Range{5900, 5999}
)

// MaxInternalRunningInstances is bounded by the smallest internal range.
func MaxInternalRunningInstances() int {
	return min(CdpPortRange.Size(), DisplayNumberRange.Size(), ViewerPortRange.Size())
}

// Config is the resolved Hub configuration.
type Config struct {
	CreationPlatform    string
	CreationRegion      profile.Region
	AuthToken           string
	BrowserBin          string
	DiskCacheSizeMB     int
	DataRoot            string
	Host                string
	MaxRunningInstances int
	MacOSFontconfigFile string
	Port                int
}

// Error is a configuration problem reported at startup.
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

// Load reads configuration from env (os.Getenv when nil).
func Load(env func(string) string, home string) (Config, error) {
	if env == nil {
		env = os.Getenv
	}
	get := func(name string) string { return strings.TrimSpace(env(name)) }
	defaults, err := profile.ResolveCreationDefaults(
		profile.Region{Timezone: get("CLOAKHUB_DEFAULT_TIMEZONE"), Locale: get("CLOAKHUB_DEFAULT_LOCALE")},
		get("CLOAKHUB_DEFAULT_PLATFORM"),
	)
	if err != nil {
		return Config{}, &Error{Message: "Invalid CLOAKHUB_DEFAULT_PLATFORM/CLOAKHUB_DEFAULT_TIMEZONE/CLOAKHUB_DEFAULT_LOCALE: " + err.Error()}
	}
	cfg := Config{
		CreationPlatform:    defaults.Platform,
		CreationRegion:      profile.Region{Timezone: defaults.Timezone, Locale: defaults.Locale},
		MacOSFontconfigFile: get("CLOAKHUB_MACOS_FONTCONFIG_FILE"),
		AuthToken:           get("CLOAKHUB_AUTH_TOKEN"),
		BrowserBin:          get("CLOAKHUB_BROWSER_BIN"),
		DataRoot:            get("CLOAKHUB_DATA_DIR"),
		Host:                get("CLOAKHUB_HOST"),
	}
	if cfg.DataRoot == "" {
		cfg.DataRoot = filepath.Join(home, ".cloakhub", "data")
	}
	if cfg.Host == "" {
		cfg.Host = DefaultHost
	}
	if cfg.DiskCacheSizeMB, err = positiveInteger(env("CLOAKHUB_DISK_CACHE_SIZE_MB"), "CLOAKHUB_DISK_CACHE_SIZE_MB", DefaultDiskCacheSizeMB, 2047); err != nil {
		return Config{}, err
	}
	if cfg.MaxRunningInstances, err = positiveInteger(env("CLOAKHUB_MAX_RUNNING_INSTANCES"), "CLOAKHUB_MAX_RUNNING_INSTANCES", DefaultMaxRunningInstances, MaxInternalRunningInstances()); err != nil {
		return Config{}, err
	}
	port, err := parseInteger(env("CLOAKHUB_PORT"), DefaultPort)
	if err != nil || port < 1 || port > 65535 {
		return Config{}, &Error{Message: "CLOAKHUB_PORT must be an integer between 1 and 65535"}
	}
	cfg.Port = port
	return cfg, nil
}

func positiveInteger(value, name string, fallback, maximum int) (int, error) {
	parsed, err := parseInteger(value, fallback)
	if err != nil || parsed < 1 {
		return 0, &Error{Message: name + " must be a positive integer"}
	}
	if maximum > 0 && parsed > maximum {
		return 0, &Error{Message: fmt.Sprintf("%s must be no more than %d", name, maximum)}
	}
	return parsed, nil
}

func parseInteger(value string, fallback int) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	if f, err := strconv.ParseFloat(value, 64); err == nil && f == float64(int(f)) {
		return int(f), nil
	}
	return 0, fmt.Errorf("not an integer")
}
