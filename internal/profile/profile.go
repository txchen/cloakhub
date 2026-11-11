// Package profile defines Browser Profiles: their stored fields, input
// validation, secret redaction, SQLite persistence and the management service.
package profile

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // IANA timezone validation without host tzdata.

	"golang.org/x/text/language"
)

var profileIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Instance statuses.
const (
	StatusFailed   = "failed"
	StatusRunning  = "running"
	StatusStarting = "starting"
	StatusStopped  = "stopped"
	StatusStopping = "stopping"
)

// Stop reasons.
const (
	StopCapacityPreemption = "capacity preemption"
	StopCrash              = "crash"
	StopIdleTimeout        = "idle timeout"
	StopLaunchFailure      = "launch failure"
	StopManual             = "manual stop"
	StopRestart            = "restart"
	StopShutdown           = "shutdown"
)

// DefaultSleepPolicyMinutes is the idle timeout of the "default" Sleep Policy.
const DefaultSleepPolicyMinutes = 30

// SleepPolicy is {mode: default|never} or {mode: minutes, minutes: N}.
type SleepPolicy struct {
	Mode    string `json:"mode"`
	Minutes *int   `json:"minutes,omitempty"`
}

// ResolvedSleepPolicy is the effective policy shown to operators.
type ResolvedSleepPolicy struct {
	BlocksSleep      bool   `json:"blocks_sleep"`
	EffectiveMinutes *int   `json:"effective_minutes"`
	Mode             string `json:"mode"`
}

// LaunchFields are the settings that shape how a Browser Instance launches.
type LaunchFields struct {
	ClipboardSync       bool        `json:"clipboard_sync"`
	ColorScheme         string      `json:"color_scheme"`
	CustomLaunchArgs    []string    `json:"custom_launch_args"`
	FingerprintSeed     string      `json:"fingerprint_seed"`
	GeoIP               string      `json:"geoip"`
	GPURenderer         string      `json:"gpu_renderer"`
	GPUVendor           string      `json:"gpu_vendor"`
	HardwareConcurrency int         `json:"hardware_concurrency"`
	Headless            bool        `json:"headless"`
	HumanPreset         string      `json:"human_preset"`
	Humanize            bool        `json:"humanize"`
	Locale              string      `json:"locale"`
	Platform            string      `json:"platform"`
	Proxy               string      `json:"proxy"`
	ScreenHeight        int         `json:"screen_height"`
	ScreenWidth         int         `json:"screen_width"`
	SleepPolicy         SleepPolicy `json:"sleep_policy"`
	Timezone            string      `json:"timezone"`
	UserAgent           string      `json:"user_agent"`
}

// Profile is a stored Browser Profile. CdpToken never serializes.
type Profile struct {
	ProfileID          string   `json:"profile_id"`
	DisplayName        string   `json:"display_name"`
	Notes              string   `json:"notes"`
	Tags               []string `json:"tags"`
	CdpToken           *string  `json:"-"`
	InstanceStatus     string   `json:"instance_status"`
	LastActivityAt     *string  `json:"last_activity_at"`
	LastDeleteError    *string  `json:"last_delete_error"`
	LastLaunchError    *string  `json:"last_launch_error"`
	LastLaunchFailedAt *string  `json:"last_launch_failed_at"`
	LastManualInputAt  *string  `json:"last_manual_input_at"`
	LastStartedAt      *string  `json:"last_started_at"`
	LastStopReason     *string  `json:"last_stop_reason"`
	LastStoppedAt      *string  `json:"last_stopped_at"`
	CreatedAt          string   `json:"created_at"`
	UpdatedAt          string   `json:"updated_at"`
	LaunchFields
	SleepPolicyStatus ResolvedSleepPolicy `json:"sleep_policy_status"`
}

// Token returns the CDP Token, or "" when the profile is open.
func (p *Profile) Token() string {
	if p.CdpToken == nil {
		return ""
	}
	return *p.CdpToken
}

// Tokens returns the CDP Token as a redaction list.
func (p *Profile) Tokens() []string {
	if t := p.Token(); t != "" {
		return []string{t}
	}
	return nil
}

// LegacyLaunchFields preserve the identity of older records that omit fields.
func LegacyLaunchFields() LaunchFields {
	return LaunchFields{
		ClipboardSync:       true,
		ColorScheme:         "system",
		CustomLaunchArgs:    []string{},
		HardwareConcurrency: 4,
		Platform:            "macos",
		ScreenHeight:        768,
		ScreenWidth:         1366,
		SleepPolicy:         SleepPolicy{Mode: "default"},
	}
}

// DefaultLaunchFields are the launch fields of a new profile before deployment defaults.
func DefaultLaunchFields() LaunchFields {
	fields := LegacyLaunchFields()
	fields.Platform = "linux"
	fields.Locale = "en-US"
	fields.Timezone = "UTC"
	return fields
}

// Region is the deployment's default timezone and locale.
type Region struct {
	Timezone string
	Locale   string
}

// ValidationError is a 400-class input problem.
type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

func invalid(format string, args ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, args...)}
}

// IsValidation reports whether err is a ValidationError.
func IsValidation(err error) bool {
	var v *ValidationError
	return errors.As(err, &v)
}

// ResolveCreationDefaults returns new-profile launch fields for a deployment.
func ResolveCreationDefaults(region Region, platform string) (LaunchFields, error) {
	if platform == "" {
		platform = DefaultLaunchFields().Platform
	}
	if platform != "linux" && platform != "windows" && platform != "macos" {
		return LaunchFields{}, invalid("default platform must be linux, windows, or macos")
	}
	timezone := region.Timezone
	if timezone == "" {
		timezone = SystemTimezone()
	}
	locale := region.Locale
	if locale == "" {
		locale = DefaultLaunchFields().Locale
	}
	if err := validateTimezone(timezone); err != nil {
		return LaunchFields{}, err
	}
	if err := validateLocale(locale); err != nil {
		return LaunchFields{}, err
	}
	fields := DefaultLaunchFields()
	fields.Platform = platform
	fields.Timezone = timezone
	fields.Locale = locale
	return fields, nil
}

// SystemTimezone is the server process timezone name, or UTC.
func SystemTimezone() string {
	if tz := strings.TrimPrefix(os.Getenv("TZ"), ":"); tz != "" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if target, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if i := strings.Index(target, "zoneinfo/"); i >= 0 {
			name := target[i+len("zoneinfo/"):]
			if _, err := time.LoadLocation(name); err == nil {
				return name
			}
		}
	}
	return "UTC"
}

var ownedLaunchFlags = []string{
	"--user-data-dir",
	"--disk-cache-size",
	"--remote-debugging-port",
	"--remote-debugging-address",
	"--remote-debugging-pipe",
	"--window-position",
	"--window-size",
}

// ValidateProfileID checks the immutable profile ID format.
func ValidateProfileID(value any) (string, error) {
	id, ok := value.(string)
	if !ok || !profileIDPattern.MatchString(id) {
		return "", invalid("Profile ID must match ^[a-z][a-z0-9_]*$")
	}
	return id, nil
}

// CreateInput is a validated profile creation request.
type CreateInput struct {
	ProfileID   string
	DisplayName string
	Notes       string
	Tags        []string
	Launch      LaunchFields
}

// UpdateInput is a validated profile edit. Nil fields are unchanged.
type UpdateInput struct {
	DisplayName *string
	Notes       *string
	Tags        []string
	TagsSet     bool
	// Apply copies the provided launch fields onto existing ones.
	Apply func(*LaunchFields)
}

// DecodeObject parses a JSON object body, keeping integers distinguishable.
func DecodeObject(body []byte) (map[string]any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, invalid("Request body must be valid JSON")
	}
	if decoder.More() {
		return nil, invalid("Request body must be valid JSON")
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil, invalid("Request body must be a JSON object")
	}
	return record, nil
}

// NormalizeCreate validates a creation body against deployment defaults.
func NormalizeCreate(input map[string]any, defaults LaunchFields) (CreateInput, error) {
	if input == nil {
		return CreateInput{}, invalid("Request body must be a JSON object")
	}
	if err := ValidateSupportedSettings(input); err != nil {
		return CreateInput{}, err
	}
	id, err := ValidateProfileID(input["profile_id"])
	if err != nil {
		return CreateInput{}, err
	}
	displayName, err := optionalString(input, "display_name")
	if err != nil {
		return CreateInput{}, err
	}
	notes, err := optionalString(input, "notes")
	if err != nil {
		return CreateInput{}, err
	}
	tags, err := normalizeTags(input["tags"], hasKey(input, "tags"))
	if err != nil {
		return CreateInput{}, err
	}
	result := CreateInput{ProfileID: id, DisplayName: id, Tags: []string{}, Launch: cloneLaunch(defaults)}
	if displayName != nil && strings.TrimSpace(*displayName) != "" {
		result.DisplayName = strings.TrimSpace(*displayName)
	}
	if notes != nil {
		result.Notes = *notes
	}
	if tags != nil {
		result.Tags = tags
	}
	apply, err := partialLaunchFields(input)
	if err != nil {
		return CreateInput{}, err
	}
	apply(&result.Launch)
	seed, _ := optionalString(input, "fingerprint_seed")
	if seed == nil || *seed == "" {
		result.Launch.FingerprintSeed = defaults.FingerprintSeed
		if result.Launch.FingerprintSeed == "" {
			result.Launch.FingerprintSeed = randomFingerprintSeed()
		}
	}
	return result, nil
}

// NormalizeUpdate validates an edit body for an existing profile.
func NormalizeUpdate(profileID string, input map[string]any) (UpdateInput, error) {
	if input == nil {
		return UpdateInput{}, invalid("Request body must be a JSON object")
	}
	if err := ValidateSupportedSettings(input); err != nil {
		return UpdateInput{}, err
	}
	if raw, ok := input["profile_id"]; ok && raw != profileID {
		return UpdateInput{}, invalid("Profile ID is immutable")
	}
	var result UpdateInput
	displayName, err := optionalString(input, "display_name")
	if err != nil {
		return UpdateInput{}, err
	}
	if displayName != nil {
		name := strings.TrimSpace(*displayName)
		if name == "" {
			name = profileID
		}
		result.DisplayName = &name
	}
	if result.Notes, err = optionalString(input, "notes"); err != nil {
		return UpdateInput{}, err
	}
	if result.Tags, err = normalizeTags(input["tags"], hasKey(input, "tags")); err != nil {
		return UpdateInput{}, err
	}
	result.TagsSet = result.Tags != nil
	if result.Apply, err = partialLaunchFields(input); err != nil {
		return UpdateInput{}, err
	}
	return result, nil
}

// partialLaunchFields validates every present launch field and returns a function
// that applies them.
func partialLaunchFields(input map[string]any) (func(*LaunchFields), error) {
	var setters []func(*LaunchFields)
	str := func(key string, set func(*LaunchFields, string)) error {
		value, err := optionalString(input, key)
		if err != nil || value == nil {
			return err
		}
		v := *value
		setters = append(setters, func(f *LaunchFields) { set(f, v) })
		return nil
	}
	boolean := func(key string, set func(*LaunchFields, bool)) error {
		raw, ok := input[key]
		if !ok {
			return nil
		}
		v, isBool := raw.(bool)
		if !isBool {
			return invalid("%s must be a boolean", key)
		}
		setters = append(setters, func(f *LaunchFields) { set(f, v) })
		return nil
	}
	integer := func(key string, minimum, maximum int, set func(*LaunchFields, int)) error {
		raw, ok := input[key]
		if !ok {
			return nil
		}
		v, err := requiredInteger(raw, key, minimum, maximum)
		if err != nil {
			return err
		}
		setters = append(setters, func(f *LaunchFields) { set(f, v) })
		return nil
	}
	steps := []error{
		boolean("clipboard_sync", func(f *LaunchFields, v bool) { f.ClipboardSync = v }),
		func() error {
			raw, ok := input["color_scheme"]
			if !ok {
				return nil
			}
			v, _ := raw.(string)
			if v != "light" && v != "dark" && v != "system" {
				return invalid("color_scheme must be light, dark, or system")
			}
			setters = append(setters, func(f *LaunchFields) { f.ColorScheme = v })
			return nil
		}(),
		func() error {
			raw, ok := input["custom_launch_args"]
			if !ok {
				return nil
			}
			list, isList := raw.([]any)
			if !isList {
				return invalid("custom_launch_args must be an array of strings")
			}
			args := make([]string, 0, len(list))
			for _, entry := range list {
				s, isString := entry.(string)
				if !isString {
					return invalid("custom_launch_args must be an array of strings")
				}
				args = append(args, s)
			}
			if err := ValidateCustomLaunchArgs(args); err != nil {
				return err
			}
			setters = append(setters, func(f *LaunchFields) { f.CustomLaunchArgs = args })
			return nil
		}(),
		str("fingerprint_seed", func(f *LaunchFields, v string) { f.FingerprintSeed = v }),
		str("geoip", func(f *LaunchFields, v string) { f.GeoIP = v }),
		str("gpu_renderer", func(f *LaunchFields, v string) { f.GPURenderer = v }),
		str("gpu_vendor", func(f *LaunchFields, v string) { f.GPUVendor = v }),
		integer("hardware_concurrency", 1, 256, func(f *LaunchFields, v int) { f.HardwareConcurrency = v }),
		boolean("headless", func(f *LaunchFields, v bool) { f.Headless = v }),
		str("human_preset", func(f *LaunchFields, v string) { f.HumanPreset = v }),
		boolean("humanize", func(f *LaunchFields, v bool) { f.Humanize = v }),
		str("locale", func(f *LaunchFields, v string) { f.Locale = v }),
		str("platform", func(f *LaunchFields, v string) { f.Platform = v }),
		func() error {
			value, err := optionalString(input, "proxy")
			if err != nil || value == nil {
				return err
			}
			proxy := *value
			if proxy != "" {
				parsed, err := parseProxy(proxy)
				if err != nil {
					return err
				}
				proxy = parsed.format()
			}
			setters = append(setters, func(f *LaunchFields) { f.Proxy = proxy })
			return nil
		}(),
		integer("screen_height", 100, 10000, func(f *LaunchFields, v int) { f.ScreenHeight = v }),
		integer("screen_width", 100, 10000, func(f *LaunchFields, v int) { f.ScreenWidth = v }),
		func() error {
			raw, ok := input["sleep_policy"]
			if !ok {
				return nil
			}
			policy, err := parseSleepPolicy(raw)
			if err != nil {
				return err
			}
			setters = append(setters, func(f *LaunchFields) { f.SleepPolicy = policy })
			return nil
		}(),
		str("timezone", func(f *LaunchFields, v string) { f.Timezone = v }),
		str("user_agent", func(f *LaunchFields, v string) { f.UserAgent = v }),
	}
	for _, err := range steps {
		if err != nil {
			return nil, err
		}
	}
	return func(f *LaunchFields) {
		for _, set := range setters {
			set(f)
		}
	}, nil
}

func hasKey(input map[string]any, key string) bool {
	_, ok := input[key]
	return ok
}

func optionalString(input map[string]any, key string) (*string, error) {
	raw, ok := input[key]
	if !ok {
		return nil, nil
	}
	value, isString := raw.(string)
	if !isString {
		return nil, invalid("%s must be a string", key)
	}
	return &value, nil
}

func requiredInteger(raw any, key string, minimum, maximum int) (int, error) {
	err := invalid("%s must be an integer between %d and %d", key, minimum, maximum)
	number, ok := raw.(json.Number)
	if !ok {
		return 0, err
	}
	f, parseErr := number.Float64()
	if parseErr != nil || f != float64(int64(f)) || f < float64(minimum) || f > float64(maximum) {
		return 0, err
	}
	return int(f), nil
}

func parseSleepPolicy(raw any) (SleepPolicy, error) {
	bad := invalid("sleep_policy.mode must be default, minutes, or never")
	record, ok := raw.(map[string]any)
	if !ok {
		return SleepPolicy{}, bad
	}
	mode, _ := record["mode"].(string)
	switch mode {
	case "default", "never":
		return SleepPolicy{Mode: mode}, nil
	case "minutes":
		minutes, err := requiredInteger(record["minutes"], "sleep_policy.minutes", 1, 1440)
		if err != nil {
			return SleepPolicy{}, err
		}
		return SleepPolicy{Mode: "minutes", Minutes: &minutes}, nil
	}
	return SleepPolicy{}, bad
}

// ResolveSleepPolicy returns the effective idle timeout and blocking state.
func ResolveSleepPolicy(policy SleepPolicy) ResolvedSleepPolicy {
	switch policy.Mode {
	case "never":
		return ResolvedSleepPolicy{BlocksSleep: true, Mode: "never"}
	case "minutes":
		if policy.Minutes != nil {
			minutes := *policy.Minutes
			return ResolvedSleepPolicy{EffectiveMinutes: &minutes, Mode: "minutes"}
		}
	}
	minutes := DefaultSleepPolicyMinutes
	return ResolvedSleepPolicy{EffectiveMinutes: &minutes, Mode: "default"}
}

// ValidateCustomLaunchArgs rejects flags CloakHub sets itself.
func ValidateCustomLaunchArgs(args []string) error {
	for _, arg := range args {
		for _, flag := range ownedLaunchFlags {
			if arg == flag || strings.HasPrefix(arg, flag+"=") {
				return invalid("custom_launch_args cannot include CloakHub-owned flag %s", flag)
			}
		}
	}
	return nil
}

// ValidateSupportedSettings rejects unsupported SDK features and invalid regions.
func ValidateSupportedSettings(input map[string]any) error {
	truthy := func(key string) bool {
		switch v := input[key].(type) {
		case bool:
			return v
		case string:
			return v != ""
		case nil:
			return false
		case json.Number:
			return v.String() != "0"
		default:
			return true
		}
	}
	if truthy("humanize") || truthy("human_preset") || truthy("geoip") {
		return invalid("Humanize and automatic GeoIP are not supported by this runtime. Clear these settings and choose an explicit timezone and locale.")
	}
	if timezone, ok := input["timezone"].(string); ok && timezone != "" {
		if err := validateTimezone(timezone); err != nil {
			return err
		}
	}
	if locale, ok := input["locale"].(string); ok && locale != "" {
		if err := validateLocale(locale); err != nil {
			return err
		}
	}
	return nil
}

// ValidateProfileSettings re-checks a stored profile before launch.
func ValidateProfileSettings(p *Profile) error {
	if p.Humanize || p.HumanPreset != "" || p.GeoIP != "" {
		return invalid("Humanize and automatic GeoIP are not supported by this runtime. Clear these settings and choose an explicit timezone and locale.")
	}
	if p.Timezone != "" {
		if err := validateTimezone(p.Timezone); err != nil {
			return err
		}
	}
	if p.Locale != "" {
		if err := validateLocale(p.Locale); err != nil {
			return err
		}
	}
	return nil
}

func validateTimezone(timezone string) error {
	if strings.EqualFold(timezone, "utc") {
		return nil
	}
	if _, err := time.LoadLocation(timezone); err != nil || timezone == "Local" {
		return invalid("timezone must be a valid IANA timezone")
	}
	return nil
}

func validateLocale(locale string) error {
	if strings.Contains(locale, "_") {
		return invalid("locale must be a valid language tag, such as en-US")
	}
	if _, err := language.Parse(locale); err != nil {
		var unknown language.ValueError
		if errors.As(err, &unknown) {
			return nil // Well-formed but unregistered subtags are still valid tags.
		}
		return invalid("locale must be a valid language tag, such as en-US")
	}
	return nil
}

func normalizeTags(raw any, present bool) ([]string, error) {
	if !present {
		return nil, nil
	}
	bad := invalid("tags must contain at most 20 nonempty names, up to 40 characters each")
	list, ok := raw.([]any)
	if !ok || len(list) > 20 {
		return nil, bad
	}
	seen := map[string]bool{}
	tags := []string{}
	for _, entry := range list {
		tag, isString := entry.(string)
		if !isString || strings.TrimSpace(tag) == "" || len([]rune(tag)) > 40 {
			return nil, bad
		}
		tag = strings.TrimSpace(tag)
		if !seen[tag] {
			seen[tag] = true
			tags = append(tags, tag)
		}
	}
	return tags, nil
}

func randomFingerprintSeed() string {
	n, err := rand.Int(rand.Reader, big.NewInt(90000))
	if err != nil {
		return "10000"
	}
	return fmt.Sprintf("%d", 10000+n.Int64())
}

func cloneLaunch(fields LaunchFields) LaunchFields {
	fields.CustomLaunchArgs = append([]string{}, fields.CustomLaunchArgs...)
	if fields.SleepPolicy.Minutes != nil {
		minutes := *fields.SleepPolicy.Minutes
		fields.SleepPolicy.Minutes = &minutes
	}
	return fields
}

type proxyURL struct {
	scheme, username, password, hostname, port string
}

func (p proxyURL) format() string {
	auth := ""
	if p.username != "" || p.password != "" {
		auth = p.username + ":" + p.password + "@"
	}
	return p.scheme + "://" + auth + p.hostname + ":" + p.port
}

var numeric = regexp.MustCompile(`^[0-9]+$`)

func parseProxy(proxy string) (proxyURL, error) {
	missing := invalid("proxy must include a hostname and port")
	if !strings.Contains(proxy, "://") {
		parts := strings.Split(proxy, ":")
		if len(parts) != 2 && len(parts) != 4 {
			return proxyURL{}, missing
		}
		if parts[0] == "" || parts[1] == "" {
			return proxyURL{}, missing
		}
		if !numeric.MatchString(parts[1]) {
			return proxyURL{}, invalid("proxy port must be numeric")
		}
		result := proxyURL{scheme: "http", hostname: parts[0], port: parts[1]}
		if len(parts) == 4 {
			result.username, result.password = parts[2], parts[3]
		}
		return result, nil
	}
	parsed, err := url.Parse(proxy)
	if err != nil || parsed.Host == "" && parsed.Opaque != "" {
		return proxyURL{}, invalid("proxy must be a valid URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" && scheme != "socks5" {
		return proxyURL{}, invalid("proxy scheme must be http, https, or socks5")
	}
	hostname := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	// A scheme's default port is implicit in a URL, so it counts as missing.
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if hostname == "" || port == "" {
		return proxyURL{}, missing
	}
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	result := proxyURL{scheme: scheme, hostname: hostname, port: port}
	if parsed.User != nil {
		result.username = parsed.User.Username()
		result.password, _ = parsed.User.Password()
	}
	return result, nil
}

// ProxyCredentials splits a stored proxy URL for the launcher.
func ProxyCredentials(proxy string) (scheme, host, username, password string, err error) {
	parsed, err := parseProxy(proxy)
	if err != nil {
		return "", "", "", "", err
	}
	return parsed.scheme, parsed.hostname + ":" + parsed.port, parsed.username, parsed.password, nil
}

// MaskProxyCredentials hides the proxy password for display.
func MaskProxyCredentials(proxy string) string {
	if proxy == "" {
		return ""
	}
	parsed, err := parseProxy(proxy)
	if err != nil || (parsed.username == "" && parsed.password == "") {
		return proxy
	}
	username := parsed.username
	if username == "" {
		username = "***"
	}
	password := ""
	if parsed.password != "" {
		password = "***"
	}
	return parsed.scheme + "://" + username + ":" + password + "@" + parsed.hostname + ":" + parsed.port
}

var (
	queryTokenPattern = regexp.MustCompile(`([?&]token=)[^&\s"')]+`)
	proxyAuthPattern  = regexp.MustCompile(`((?:https?|socks5)://)([^:\s/@]+):([^@\s]+)@([^:\s/@]+):([0-9]+)`)
)

// RedactCdpTokens removes query tokens and known CDP Tokens from a message.
func RedactCdpTokens(message string, tokens []string) string {
	message = queryTokenPattern.ReplaceAllString(message, "${1}***")
	for _, token := range tokens {
		if token != "" {
			message = strings.ReplaceAll(message, token, "***")
		}
	}
	return message
}

// RedactSecrets removes CDP Tokens and proxy passwords from a message.
func RedactSecrets(message string, tokens []string) string {
	return proxyAuthPattern.ReplaceAllString(RedactCdpTokens(message, tokens), "${1}${2}:***@${4}:${5}")
}
