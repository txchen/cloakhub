// Package viewer holds the Hub-wide live viewer stream settings.
package viewer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Settings bound voxl's adaptive H.264 rate control. The stream still drops to near
// zero on a still screen and backs off on a congested link; these only cap it.
type Settings struct {
	MaxKbps   int `json:"max_kbps"`
	Framerate int `json:"framerate"`
	Crf       int `json:"crf"`
}

// Limit is an inclusive bound.
type Limit struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// Presets are the named settings offered in the viewer toolbar.
var Presets = map[string]Settings{
	"data-saver": {MaxKbps: 2500, Framerate: 30, Crf: 28},
	"balanced":   {MaxKbps: 8000, Framerate: 60, Crf: 25},
	"high":       {MaxKbps: 30000, Framerate: 60, Crf: 23},
}

// Limits bound custom settings.
var Limits = map[string]Limit{
	"max_kbps":  {Min: 300, Max: 50000},
	"framerate": {Min: 5, Max: 60},
	"crf":       {Min: 16, Max: 40},
}

// Default is the setting of a new Hub.
var Default = Presets["balanced"]

// InvalidError is a rejected settings update.
type InvalidError struct{ Message string }

func (e *InvalidError) Error() string { return e.Message }

// Store persists the settings in data/viewer-settings.json.
type Store struct {
	mu       sync.Mutex
	path     string
	dataRoot string
	current  Settings
	onChange func(Settings)
}

// Open loads saved settings; onChange runs after a saved change.
func Open(dataRoot string, onChange func(Settings)) *Store {
	store := &Store{path: filepath.Join(dataRoot, "viewer-settings.json"), dataRoot: dataRoot, current: Default, onChange: onChange}
	if raw, err := os.ReadFile(store.path); err == nil {
		var input map[string]any
		if json.Unmarshal(raw, &input) == nil {
			if parsed, err := Parse(input, Default); err == nil {
				store.current = parsed
			}
		}
	}
	return store
}

// Get returns the current settings.
func (s *Store) Get() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

// Update validates, saves and applies a full, partial or preset update.
func (s *Store) Update(input map[string]any) (Settings, error) {
	s.mu.Lock()
	next, err := Parse(input, s.current)
	if err != nil {
		s.mu.Unlock()
		return Settings{}, err
	}
	raw, _ := json.MarshalIndent(next, "", "  ")
	if err := os.MkdirAll(s.dataRoot, 0o755); err != nil {
		s.mu.Unlock()
		return Settings{}, err
	}
	temporary := s.path + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o644); err != nil {
		s.mu.Unlock()
		return Settings{}, err
	}
	if err := os.Rename(temporary, s.path); err != nil {
		s.mu.Unlock()
		return Settings{}, err
	}
	changed := next != s.current
	s.current = next
	onChange := s.onChange
	s.mu.Unlock()
	if changed && onChange != nil {
		onChange(next)
	}
	return next, nil
}

// Parse validates an input object, filling gaps from base.
func Parse(input map[string]any, base Settings) (Settings, error) {
	if input == nil {
		return Settings{}, &InvalidError{"Viewer settings must be a JSON object"}
	}
	if raw, ok := input["preset"]; ok {
		if name, isString := raw.(string); isString {
			preset, known := Presets[name]
			if !known {
				return Settings{}, &InvalidError{fmt.Sprintf("Unknown viewer preset %q", name)}
			}
			return preset, nil
		}
	}
	result := base
	for _, key := range []string{"max_kbps", "framerate", "crf"} {
		raw, ok := input[key]
		if !ok {
			continue
		}
		limit := Limits[key]
		value, isNumber := asInteger(raw)
		if !isNumber || value < limit.Min || value > limit.Max {
			return Settings{}, &InvalidError{fmt.Sprintf("%s must be an integer from %d to %d", key, limit.Min, limit.Max)}
		}
		switch key {
		case "max_kbps":
			result.MaxKbps = value
		case "framerate":
			result.Framerate = value
		case "crf":
			result.Crf = value
		}
	}
	return result, nil
}

func asInteger(raw any) (int, bool) {
	var f float64
	switch v := raw.(type) {
	case float64:
		f = v
	case json.Number:
		parsed, err := v.Float64()
		if err != nil {
			return 0, false
		}
		f = parsed
	default:
		return 0, false
	}
	if f != float64(int(f)) {
		return 0, false
	}
	return int(f), true
}

// PresetFor names the preset these settings match, or "custom".
func PresetFor(settings Settings) string {
	for name, preset := range Presets {
		if preset == settings {
			return name
		}
	}
	return "custom"
}

// VoxlFlags maps settings to voxl flags. voxl's --max-kbps is a rate-control target
// and x264 may spend up to twice that on a moving frame, so it gets half the
// ceiling to keep measured peaks near max_kbps.
func VoxlFlags(settings Settings) []string {
	target := (settings.MaxKbps + 1) / 2
	minimum := min(2000, max(100, target/2))
	return []string{
		fmt.Sprintf("--max-kbps=%d", target),
		fmt.Sprintf("--min-kbps=%d", minimum),
		fmt.Sprintf("--framerate=%d", settings.Framerate),
		fmt.Sprintf("--crf=%d", settings.Crf),
	}
}
