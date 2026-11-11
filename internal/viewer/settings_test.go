package viewer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestStorePersistsAndNotifiesOnChange(t *testing.T) {
	dataRoot := t.TempDir()
	var changes []Settings
	store := Open(dataRoot, func(s Settings) { changes = append(changes, s) })
	if store.Get() != Default {
		t.Fatal("default")
	}
	store.Update(map[string]any{"preset": "data-saver"})
	store.Update(map[string]any{"preset": "data-saver"})
	store.Update(map[string]any{"crf": 30.0})
	if len(changes) != 2 || changes[1] != (Settings{MaxKbps: 2500, Framerate: 30, Crf: 30}) {
		t.Errorf("changes %+v", changes)
	}
	raw, _ := os.ReadFile(filepath.Join(dataRoot, "viewer-settings.json"))
	var saved Settings
	json.Unmarshal(raw, &saved)
	if saved != changes[1] {
		t.Errorf("saved %+v", saved)
	}
	if reopened := Open(dataRoot, nil).Get(); reopened != changes[1] || PresetFor(reopened) != "custom" {
		t.Errorf("reopened %+v", reopened)
	}
}

func TestParseRejectsOutOfRangeValues(t *testing.T) {
	for _, input := range []map[string]any{{"max_kbps": 10.0}, {"framerate": 120.0}, {"crf": 24.5}, {"preset": "ultra"}, {"crf": "24"}, nil} {
		if _, err := Parse(input, Default); err == nil {
			t.Errorf("%v accepted", input)
		}
	}
}

func TestVoxlFlagsKeepPeaksNearTheCeiling(t *testing.T) {
	if got := VoxlFlags(Presets["data-saver"]); !slices.Equal(got, []string{"--max-kbps=1250", "--min-kbps=625", "--framerate=30", "--crf=28"}) {
		t.Errorf("flags %v", got)
	}
	if got := VoxlFlags(Settings{MaxKbps: 300, Framerate: 15, Crf: 30}); got[1] != "--min-kbps=100" {
		t.Errorf("floor %v", got)
	}
	if got := VoxlFlags(Presets["high"]); got[0] != "--max-kbps=15000" || got[1] != "--min-kbps=2000" {
		t.Errorf("high %v", got)
	}
}
