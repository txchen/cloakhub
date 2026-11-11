package procs

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
	"time"
)

func TestEnvMarksOwnership(t *testing.T) {
	env := (&Registry{DataRoot: "/data"}).Env("work", []string{"PATH=/bin", "CLOAKHUB_PROFILE_ID=stale"})
	if !slices.Equal(env, []string{"PATH=/bin", "CLOAKHUB_DATA_ROOT=/data", "CLOAKHUB_PROFILE_ID=work"}) {
		t.Errorf("env %v", env)
	}
	if !HasMarker("PATH=/bin\x00CLOAKHUB_DATA_ROOT=/data\x00CLOAKHUB_PROFILE_ID=work", "/data", "work") ||
		HasMarker("CLOAKHUB_DATA_ROOT=/data\x00CLOAKHUB_PROFILE_ID=other", "/data", "work") {
		t.Error("marker matching")
	}
}

func TestCleanupStopsMarkedProcessesAndIgnoresReusedPids(t *testing.T) {
	dataRoot := t.TempDir()
	registry := NewRegistry(dataRoot)
	registry.Wait = func(time.Duration) {}

	owned := exec.Command("sleep", "30")
	owned.Env = registry.Env("work", nil)
	ownedHandle, err := Start(owned)
	if err != nil {
		t.Fatal(err)
	}
	registry.WritePid("work", Display, ownedHandle.Pid())

	bystander := exec.Command("sleep", "30")
	bystanderHandle, err := Start(bystander)
	if err != nil {
		t.Fatal(err)
	}
	defer bystanderHandle.Kill()
	// Pid files from another PID namespace can name unrelated processes, or the Hub.
	registry.WritePid("stale", Display, bystanderHandle.Pid())
	registry.WritePid("hub", Browser, os.Getpid())

	if ids := registry.OwnedProfileIDs(nil); !slices.Contains(ids, "work") {
		t.Errorf("owned ids %v", ids)
	}
	registry.Cleanup(nil, nil)
	select {
	case <-ownedHandle.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("owned process survived cleanup")
	}
	if bystanderHandle.Exited() {
		t.Error("cleanup killed a process without the ownership marker")
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "runtime", "work")); !os.IsNotExist(err) {
		t.Error("runtime directory kept")
	}
}

func TestResourceUsageSumsProcessGroups(t *testing.T) {
	dataRoot := t.TempDir()
	registry := NewRegistry(dataRoot)
	cmd := exec.Command("sh", "-c", "sleep 30 & sleep 30")
	cmd.Env = registry.Env("work", nil)
	handle, err := Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Kill()
	registry.WritePid("work", Browser, handle.Pid())
	time.Sleep(100 * time.Millisecond)
	usage := registry.ResourceUsageByProfile([]string{"work", "idle"})
	if usage["work"].OwnedProcessCount < 2 || usage["work"].RSSBytes == nil || *usage["work"].RSSBytes <= 0 {
		t.Errorf("usage %+v", usage["work"])
	}
	if usage["idle"].OwnedProcessCount != 0 || usage["idle"].RSSBytes != nil {
		t.Errorf("idle usage %+v", usage["idle"])
	}
	handle.Terminate()
	select {
	case <-handle.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("process group survived SIGTERM")
	}
	if code := handle.ExitCode(); code != -1 {
		t.Logf("exit code %d", code)
	}
	_ = syscall.Kill(-handle.Pid(), syscall.SIGKILL)
}
