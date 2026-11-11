package config

import "testing"

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestDefaults(t *testing.T) {
	cfg, err := Load(env(map[string]string{"CLOAKHUB_DEFAULT_TIMEZONE": "UTC"}), "/home/me")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataRoot != "/home/me/.cloakhub/data" || cfg.Host != "127.0.0.1" || cfg.Port != 7788 || cfg.MaxRunningInstances != 10 ||
		cfg.DiskCacheSizeMB != 256 || cfg.CreationPlatform != "linux" || cfg.CreationRegion.Locale != "en-US" {
		t.Errorf("defaults %+v", cfg)
	}
}

func TestOverridesAndValidation(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"CLOAKHUB_DATA_DIR": "/data", "CLOAKHUB_HOST": "0.0.0.0", "CLOAKHUB_PORT": "8080", "CLOAKHUB_AUTH_TOKEN": " t ",
		"CLOAKHUB_MAX_RUNNING_INSTANCES": "20", "CLOAKHUB_DEFAULT_PLATFORM": "macos",
		"CLOAKHUB_DEFAULT_TIMEZONE": "Asia/Tokyo", "CLOAKHUB_DEFAULT_LOCALE": "ja-JP", "CLOAKHUB_DISK_CACHE_SIZE_MB": "64",
	}), "/home")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataRoot != "/data" || cfg.Port != 8080 || cfg.AuthToken != "t" || cfg.MaxRunningInstances != 20 ||
		cfg.CreationPlatform != "macos" || cfg.CreationRegion.Timezone != "Asia/Tokyo" || cfg.DiskCacheSizeMB != 64 {
		t.Errorf("overrides %+v", cfg)
	}
	for name, value := range map[string]string{
		"CLOAKHUB_PORT": "70000", "CLOAKHUB_MAX_RUNNING_INSTANCES": "101", "CLOAKHUB_DISK_CACHE_SIZE_MB": "0",
		"CLOAKHUB_DEFAULT_PLATFORM": "beos", "CLOAKHUB_DEFAULT_TIMEZONE": "Mars/Base",
	} {
		if _, err := Load(env(map[string]string{name: value}), "/home"); err == nil {
			t.Errorf("%s=%s accepted", name, value)
		}
	}
}
