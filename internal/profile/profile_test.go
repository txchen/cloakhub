package profile

import (
	"database/sql"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func body(t *testing.T, raw string) map[string]any {
	t.Helper()
	value, err := DecodeObject([]byte(raw))
	if err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return value
}

func defaults(t *testing.T) LaunchFields {
	t.Helper()
	fields, err := ResolveCreationDefaults(Region{Timezone: "UTC"}, "")
	if err != nil {
		t.Fatal(err)
	}
	return fields
}

func TestRejectsUnsupportedFeaturesAndInvalidRegions(t *testing.T) {
	for _, settings := range []string{
		`"humanize":true`, `"human_preset":"careful"`, `"geoip":"US"`,
		`"timezone":"Not/AZone"`, `"locale":"not_a_locale"`,
	} {
		if _, err := NormalizeCreate(body(t, `{"profile_id":"work",`+settings+`}`), defaults(t)); err == nil {
			t.Errorf("%s was accepted", settings)
		}
	}
	for _, settings := range []string{`"timezone":"Asia/Tokyo"`, `"locale":"ja-JP"`, `"locale":"zh-Hant-TW"`, `"timezone":"UTC"`} {
		if _, err := NormalizeCreate(body(t, `{"profile_id":"work",`+settings+`}`), defaults(t)); err != nil {
			t.Errorf("%s was rejected: %v", settings, err)
		}
	}
}

func TestProfileIDs(t *testing.T) {
	for _, id := range []string{"work", "work_2026"} {
		if got, err := ValidateProfileID(id); err != nil || got != id {
			t.Errorf("%q rejected: %v", id, err)
		}
	}
	for _, id := range []any{"Work", "1work", "", 7, nil} {
		if _, err := ValidateProfileID(id); err == nil || err.Error() != "Profile ID must match ^[a-z][a-z0-9_]*$" {
			t.Errorf("%v accepted or wrong error: %v", id, err)
		}
	}
}

func TestCreateDefaultsAndFieldSet(t *testing.T) {
	created, err := NormalizeCreate(body(t, `{"profile_id":"work"}`), defaults(t))
	if err != nil {
		t.Fatal(err)
	}
	if created.Launch.Platform != "linux" || created.Launch.Headless || created.Launch.Locale != "en-US" ||
		created.Launch.ScreenHeight != 768 || created.Launch.ScreenWidth != 1366 || created.DisplayName != "work" {
		t.Errorf("unexpected defaults: %+v", created)
	}
	if !regexp.MustCompile(`^[0-9]{5}$`).MatchString(created.Launch.FingerprintSeed) {
		t.Errorf("seed %q", created.Launch.FingerprintSeed)
	}

	full, err := NormalizeCreate(body(t, `{
		"clipboard_sync": false, "color_scheme": "dark", "custom_launch_args": ["--disable-webgl"],
		"fingerprint_seed": "seed-1", "geoip": "", "gpu_renderer": "Mesa", "gpu_vendor": "Intel",
		"hardware_concurrency": 8, "headless": true, "human_preset": "", "humanize": false,
		"locale": "en-US", "platform": "linux", "profile_id": "work", "display_name": "  Work  ",
		"proxy": "proxy.example:8080:user:secret", "screen_height": 1080, "screen_width": 1920,
		"sleep_policy": {"mode": "minutes", "minutes": 45}, "timezone": "America/Los_Angeles",
		"user_agent": "Mozilla/5.0", "tags": ["a", " a ", "b"]}`), defaults(t))
	if err != nil {
		t.Fatal(err)
	}
	l := full.Launch
	if l.ClipboardSync || l.ColorScheme != "dark" || l.CustomLaunchArgs[0] != "--disable-webgl" ||
		l.Proxy != "http://user:secret@proxy.example:8080" || l.SleepPolicy.Mode != "minutes" || *l.SleepPolicy.Minutes != 45 ||
		l.FingerprintSeed != "seed-1" || l.HardwareConcurrency != 8 || !l.Headless || full.DisplayName != "Work" ||
		strings.Join(full.Tags, ",") != "a,b" {
		t.Errorf("unexpected normalized profile: %+v %+v", full, l)
	}
}

func TestRejectsInvalidValues(t *testing.T) {
	cases := map[string]string{
		`"proxy":"http://proxy.example"`:                        "proxy must include a hostname and port",
		`"proxy":"proxy.example:"`:                              "proxy must include a hostname and port",
		`"proxy":"proxy.example:not-a-port"`:                    "proxy port must be numeric",
		`"proxy":"ftp://proxy.example:21"`:                      "proxy scheme must be http, https, or socks5",
		`"screen_width":0`:                                      "screen_width must be an integer between 100 and 10000",
		`"screen_width":1366.5`:                                 "screen_width must be an integer between 100 and 10000",
		`"headless":"yes"`:                                      "headless must be a boolean",
		`"notes":7`:                                             "notes must be a string",
		`"custom_launch_args":["--remote-debugging-port=9222"]`: "custom_launch_args cannot include CloakHub-owned flag --remote-debugging-port",
		`"custom_launch_args":["--remote-debugging-pipe"]`:      "custom_launch_args cannot include CloakHub-owned flag --remote-debugging-pipe",
		`"custom_launch_args":["--window-size=800,800"]`:        "custom_launch_args cannot include CloakHub-owned flag --window-size",
		`"custom_launch_args":["--disk-cache-size=0"]`:          "custom_launch_args cannot include CloakHub-owned flag --disk-cache-size",
		`"custom_launch_args":[1]`:                              "custom_launch_args must be an array of strings",
		`"sleep_policy":{"mode":"minutes","minutes":0}`:         "sleep_policy.minutes must be an integer between 1 and 1440",
		`"sleep_policy":{"mode":"minutes","minutes":1441}`:      "sleep_policy.minutes must be an integer between 1 and 1440",
		`"sleep_policy":{"mode":"minutes"}`:                     "sleep_policy.minutes must be an integer between 1 and 1440",
		`"sleep_policy":{"mode":"minutes","minutes":1.5}`:       "sleep_policy.minutes must be an integer between 1 and 1440",
		`"sleep_policy":{"mode":"unsupported"}`:                 "sleep_policy.mode must be default, minutes, or never",
		`"color_scheme":"blue"`:                                 "color_scheme must be light, dark, or system",
		`"tags":["` + strings.Repeat("x", 41) + `"]`:            "tags must contain at most 20 nonempty names, up to 40 characters each",
	}
	for settings, message := range cases {
		_, err := NormalizeCreate(body(t, `{"profile_id":"work",`+settings+`}`), defaults(t))
		if err == nil || err.Error() != message || !IsValidation(err) {
			t.Errorf("%s: got %v, want %q", settings, err, message)
		}
	}
}

func TestUpdateKeepsIDImmutableAndOnlyAppliesPresentFields(t *testing.T) {
	if _, err := NormalizeUpdate("work", body(t, `{"profile_id":"other"}`)); err == nil || err.Error() != "Profile ID is immutable" {
		t.Fatalf("got %v", err)
	}
	update, err := NormalizeUpdate("work", body(t, `{"display_name":"  ","screen_width":1440}`))
	if err != nil {
		t.Fatal(err)
	}
	fields := LegacyLaunchFields()
	update.Apply(&fields)
	if *update.DisplayName != "work" || fields.ScreenWidth != 1440 || fields.ScreenHeight != 768 || update.Notes != nil || update.TagsSet {
		t.Errorf("unexpected update %+v %+v", update, fields)
	}
}

func TestRedaction(t *testing.T) {
	if got := RedactSecrets("launch failed for http://user:secret@proxy.example:8080", nil); got != "launch failed for http://user:***@proxy.example:8080" {
		t.Errorf("proxy redaction: %q", got)
	}
	got := RedactCdpTokens("failed to fetch /api/profiles/work/cdp/json/version?token=profile-token with Bearer profile-token", []string{"profile-token"})
	if got != "failed to fetch /api/profiles/work/cdp/json/version?token=*** with Bearer ***" {
		t.Errorf("token redaction: %q", got)
	}
	if got := MaskProxyCredentials("http://user:secret@proxy.example:8080"); got != "http://user:***@proxy.example:8080" {
		t.Errorf("mask: %q", got)
	}
	if got := MaskProxyCredentials("socks5://proxy.example:1080"); got != "socks5://proxy.example:1080" {
		t.Errorf("mask without credentials: %q", got)
	}
}

func TestSleepPolicy(t *testing.T) {
	five := 45
	if got := ResolveSleepPolicy(SleepPolicy{Mode: "default"}); got.BlocksSleep || *got.EffectiveMinutes != 30 || got.Mode != "default" {
		t.Errorf("default: %+v", got)
	}
	if got := ResolveSleepPolicy(SleepPolicy{Mode: "minutes", Minutes: &five}); *got.EffectiveMinutes != 45 || got.Mode != "minutes" {
		t.Errorf("minutes: %+v", got)
	}
	if got := ResolveSleepPolicy(SleepPolicy{Mode: "never"}); !got.BlocksSleep || got.EffectiveMinutes != nil {
		t.Errorf("never: %+v", got)
	}
}

func openRepo(t *testing.T, dataRoot string) *Repository {
	t.Helper()
	repo, err := OpenRepository(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Migrate(); err != nil {
		t.Fatal(err)
	}
	return repo
}

func TestRepositoryLegacyRowsKeepHistoricalDefaults(t *testing.T) {
	dataRoot := t.TempDir()
	repo := openRepo(t, dataRoot)
	if _, err := repo.Create(CreateInput{ProfileID: "legacy", DisplayName: "Legacy", Launch: DefaultLaunchFields()}); err != nil {
		t.Fatal(err)
	}
	repo.Close()
	db, err := sql.Open("sqlite", filepath.Join(dataRoot, "cloakhub.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE profiles SET launch_profile_json = '{}', tags_json = '[]' WHERE profile_id = 'legacy'"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	reopened := openRepo(t, dataRoot)
	defer reopened.Close()
	check := func() {
		p := reopened.Get("legacy")
		if p.Platform != "macos" || p.Locale != "" || p.Timezone != "" || p.SleepPolicy.Mode != "default" || p.HardwareConcurrency != 4 {
			t.Errorf("legacy fields: %+v", p.LaunchFields)
		}
	}
	check()
	notes := "Updated"
	if _, err := reopened.Update("legacy", UpdateInput{Notes: &notes}); err != nil {
		t.Fatal(err)
	}
	check()
	if reopened.Get("legacy").Notes != "Updated" {
		t.Error("notes not updated")
	}
}

func TestRepositoryMigratesIdempotentlyAndPersistsLifecycle(t *testing.T) {
	dataRoot := t.TempDir()
	repo := openRepo(t, dataRoot)
	minutes := 45
	launch := DefaultLaunchFields()
	launch.SleepPolicy = SleepPolicy{Mode: "minutes", Minutes: &minutes}
	launch.Proxy = "http://u:p@h:8080"
	if _, err := repo.Create(CreateInput{ProfileID: "work", DisplayName: "Work", Tags: []string{"x"}, Launch: launch}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Create(CreateInput{ProfileID: "personal", Launch: DefaultLaunchFields()}); err != nil {
		t.Fatal(err)
	}
	repo.MarkStarting("work")
	repo.MarkRunning("work", "2026-01-01T00:00:00.000Z")
	repo.RecordActivity("work", "2026-01-01T00:01:00.000Z")
	repo.RecordManualInput("work", "2026-01-01T00:02:00.000Z")
	repo.MarkLaunchFailed("personal", "boom", "2026-01-01T00:03:00.000Z")
	token := "cdp_x"
	repo.SetCdpToken("work", &token)
	repo.Close()

	second := openRepo(t, dataRoot)
	defer second.Close()
	if err := second.Migrate(); err != nil {
		t.Fatal(err)
	}
	profiles := second.List()
	if len(profiles) != 2 || profiles[0].ProfileID != "personal" || profiles[1].ProfileID != "work" {
		t.Fatalf("list order: %v", profiles)
	}
	work := second.Get("work")
	if work.InstanceStatus != "running" || *work.LastStartedAt != "2026-01-01T00:00:00.000Z" ||
		*work.LastActivityAt != "2026-01-01T00:02:00.000Z" || *work.LastManualInputAt != "2026-01-01T00:02:00.000Z" ||
		*work.SleepPolicyStatus.EffectiveMinutes != 45 || work.Proxy != "http://u:p@h:8080" || work.Token() != "cdp_x" ||
		work.DisplayName != "Work" || work.Tags[0] != "x" {
		t.Errorf("work: %+v", work)
	}
	personal := second.Get("personal")
	if personal.InstanceStatus != "failed" || *personal.LastLaunchError != "boom" || *personal.LastStopReason != "launch failure" || personal.DisplayName != "personal" {
		t.Errorf("personal: %+v", personal)
	}
	second.MarkAllStopped(StopRestart, "2026-01-01T00:04:00.000Z")
	for _, p := range second.List() {
		if p.InstanceStatus != "stopped" || *p.LastStopReason != "restart" {
			t.Errorf("%s not stopped: %+v", p.ProfileID, p)
		}
	}
	second.Delete("personal")
	if second.Get("personal") != nil {
		t.Error("deleted profile still present")
	}
}

type failingStore struct{}

func (failingStore) CreateProfileData(string) error { return nil }
func (failingStore) RemoveProfileData(string) error { return errTest }

var errTest = &ValidationError{Message: "disk on fire"}

func TestServiceLifecycleTokensAndDeletion(t *testing.T) {
	dataRoot := t.TempDir()
	repo := openRepo(t, dataRoot)
	defer repo.Close()
	tokens := 0
	service, err := NewService(ServiceOptions{
		DataRoot: dataRoot, Repository: repo, CreationRegion: Region{Timezone: "Asia/Tokyo", Locale: "ja-JP"}, CreationPlatform: "macos",
		TokenGenerator: func() string { tokens++; return "cdp_" + strings.Repeat("t", tokens) },
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.Create(body(t, `{"profile_id":"work"}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.Timezone != "Asia/Tokyo" || created.Locale != "ja-JP" || created.Platform != "macos" {
		t.Errorf("deployment defaults not applied: %+v", created.LaunchFields)
	}
	if _, err := service.Create(body(t, `{"profile_id":"work"}`)); err == nil || err.Error() != `Browser Profile "work" already exists` {
		t.Errorf("duplicate: %v", err)
	}
	first, _ := service.CreateCdpToken("work")
	again, _ := service.CreateCdpToken("work")
	if *first.CdpToken != "cdp_t" || *again.CdpToken != "cdp_t" || !again.CdpTokenConfigured {
		t.Errorf("create token: %+v %+v", first, again)
	}
	regenerated, _ := service.RegenerateCdpToken("work")
	if *regenerated.CdpToken != "cdp_tt" || strings.Join(service.TokensForRedaction(), ",") != "cdp_tt" {
		t.Errorf("regenerate: %+v", regenerated)
	}
	if err := service.RevokeCdpToken("work"); err != nil {
		t.Fatal(err)
	}
	if state, _ := service.GetCdpToken("work"); state.CdpToken != nil || state.CdpTokenConfigured {
		t.Errorf("revoke: %+v", state)
	}
	if _, err := service.GetCdpToken("missing"); err == nil {
		t.Error("missing profile token")
	}
	repo.MarkRunning("work", "2026-01-01T00:00:00.000Z")
	if err := service.DeleteStopped("work"); err == nil || !IsValidation(err) {
		t.Errorf("deleted a running profile: %v", err)
	}
	repo.MarkStopped("work", StopManual, "2026-01-01T00:00:00.000Z")
	if err := service.DeleteStopped("work"); err != nil || service.Get("work") != nil {
		t.Errorf("delete: %v", err)
	}

	failing, _ := NewService(ServiceOptions{DataRoot: dataRoot, Repository: repo, FileStore: failingStore{}})
	if _, err := failing.Create(body(t, `{"profile_id":"kept"}`)); err != nil {
		t.Fatal(err)
	}
	err = failing.DeleteStopped("kept")
	if _, ok := err.(*DeleteDataError); !ok || failing.Get("kept") == nil || *failing.Get("kept").LastDeleteError != "disk on fire" {
		t.Errorf("failed deletion must keep the profile visible: %v", err)
	}
}
