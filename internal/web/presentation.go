package web

import (
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/profile"
)

// connection is the agent-facing connection metadata; it never holds credentials.
type connection struct {
	CdpURL          string `json:"cdp_url"`
	CdpWsURL        string `json:"cdp_ws_url"`
	CdpDiscoveryURL string `json:"cdp_discovery_url"`
	Auth            string `json:"auth"`
	CdpTokenURL     string `json:"cdp_token_url"`
}

func profileConnection(p *profile.Profile, public *url.URL) *connection {
	profileURL := origin(public) + "/api/profiles/" + url.PathEscape(p.ProfileID)
	cdpURL := profileURL + "/cdp"
	auth := "none"
	if p.Token() != "" {
		auth = "cdp_token"
	}
	return &connection{
		CdpURL:          cdpURL,
		CdpWsURL:        "ws" + strings.TrimPrefix(cdpURL, "http"),
		CdpDiscoveryURL: cdpURL + "/json/version",
		Auth:            auth,
		CdpTokenURL:     profileURL + "/cdp-token",
	}
}

type summary struct {
	ProfileID         string      `json:"profile_id"`
	DisplayName       string      `json:"display_name"`
	Notes             string      `json:"notes"`
	Headless          bool        `json:"headless"`
	InstanceStatus    string      `json:"instance_status"`
	CdpSessionCount   int         `json:"cdp_session_count"`
	ManualViewerCount int         `json:"manual_viewer_count"`
	LastLaunchError   *string     `json:"last_launch_error"`
	Connection        *connection `json:"connection,omitempty"`
}

type presented struct {
	profile.Profile
	CdpTokenConfigured bool                            `json:"cdp_token_configured"`
	CdpSessionCount    int                             `json:"cdp_session_count"`
	CdpSessionLabels   []string                        `json:"cdp_session_labels"`
	CdpSessions        []browser.CdpSessionObservation `json:"cdp_sessions"`
	LastManualInputAt  *string                         `json:"last_manual_input_at"`
	ManualViewerCount  int                             `json:"manual_viewer_count"`
	ProfileDataDir     string                          `json:"profile_data_dir"`
	ResourceUsage      procs.ResourceUsage             `json:"resource_usage"`
	ResourceUsageLabel string                          `json:"resource_usage_label"`
	SleepPolicyLabel   string                          `json:"sleep_policy_label"`
	SleepStatus        string                          `json:"sleep_status"`
	Connection         *connection                     `json:"connection,omitempty"`
}

func redacted(message *string, p *profile.Profile) *string {
	if message == nil || *message == "" {
		return nil
	}
	value := profile.RedactSecrets(*message, p.Tokens())
	return &value
}

func (s *Server) summary(p *profile.Profile) summary {
	result := summary{
		ProfileID:       p.ProfileID,
		DisplayName:     p.DisplayName,
		Notes:           p.Notes,
		Headless:        p.Headless,
		InstanceStatus:  p.InstanceStatus,
		LastLaunchError: redacted(p.LastLaunchError, p),
	}
	if s.runtime != nil {
		result.CdpSessionCount = s.runtime.ActiveCdpSessionCount(p.ProfileID)
		result.ManualViewerCount = s.runtime.ActiveViewerCount(p.ProfileID)
	}
	return result
}

// present builds full profile views; redact masks proxy credentials (UI views).
func (s *Server) present(profiles []*profile.Profile, redact bool) []presented {
	ids := make([]string, len(profiles))
	for i, p := range profiles {
		ids[i] = p.ProfileID
	}
	usage := s.owned.ResourceUsageByProfile(ids)
	result := make([]presented, 0, len(profiles))
	for _, p := range profiles {
		view := presented{Profile: *p}
		if redact {
			view.Proxy = profile.MaskProxyCredentials(p.Proxy)
		}
		view.LastLaunchError = redacted(p.LastLaunchError, p)
		view.LastDeleteError = redacted(p.LastDeleteError, p)
		view.CdpTokenConfigured = p.Token() != ""
		view.CdpSessions = []browser.CdpSessionObservation{}
		if s.runtime != nil {
			view.CdpSessionCount = s.runtime.ActiveCdpSessionCount(p.ProfileID)
			view.CdpSessions = s.runtime.CdpSessionObservations(p.ProfileID)
			view.LastManualInputAt = s.runtime.LastManualInputAt(p.ProfileID)
			view.ManualViewerCount = s.runtime.ActiveViewerCount(p.ProfileID)
		}
		view.CdpSessionLabels = make([]string, 0, len(view.CdpSessions))
		for _, session := range view.CdpSessions {
			view.CdpSessionLabels = append(view.CdpSessionLabels, sessionLabel(session))
		}
		view.ProfileDataDir = profile.DataDir(s.config.DataRoot, p.ProfileID)
		view.ResourceUsage = usage[p.ProfileID]
		view.ResourceUsageLabel = resourceUsageLabel(view.ResourceUsage)
		view.SleepPolicyLabel = sleepPolicyLabel(p)
		view.SleepStatus = sleepStatusLabel(&view)
		result = append(result, view)
	}
	return result
}

func (s *Server) dashboardProfiles() []presented {
	profiles := s.profiles.List()
	sort.SliceStable(profiles, func(i, j int) bool {
		a, b := profiles[i], profiles[j]
		if a.InstanceStatus != b.InstanceStatus {
			return a.InstanceStatus < b.InstanceStatus
		}
		if ta, tb := timestampMs(a.LastActivityAt), timestampMs(b.LastActivityAt); ta != tb {
			return ta > tb
		}
		return a.ProfileID < b.ProfileID
	})
	return s.present(profiles, true)
}

func timestampMs(value *string) int64 {
	if value == nil {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func sleepPolicyLabel(p *profile.Profile) string {
	if p.SleepPolicyStatus.Mode == "never" {
		return "never-sleep"
	}
	return fmt.Sprintf("Sleep Policy: %d minutes", *p.SleepPolicyStatus.EffectiveMinutes)
}

func sleepStatusLabel(view *presented) string {
	switch {
	case view.SleepPolicyStatus.BlocksSleep:
		return "Sleep Blocker: never-sleep policy"
	case view.CdpSessionCount > 0:
		return "Sleep Blocker: active CDP Session"
	case view.InstanceStatus != profile.StatusRunning:
		return "Sleep Countdown: not running"
	case view.LastActivityAt == nil || view.SleepPolicyStatus.EffectiveMinutes == nil:
		return "Sleep Countdown: unavailable"
	}
	remaining := timestampMs(view.LastActivityAt) + int64(*view.SleepPolicyStatus.EffectiveMinutes)*60_000 - time.Now().UnixMilli()
	if remaining <= 0 {
		return "Sleep Countdown: due now"
	}
	return "Sleep Countdown: " + formatDuration(remaining)
}

func resourceUsageLabel(usage procs.ResourceUsage) string {
	if usage.RSSBytes == nil {
		return "Approx. Resource Usage: unavailable"
	}
	bytes := float64(*usage.RSSBytes)
	if bytes < 1024*1024 {
		return fmt.Sprintf("Approx. Resource Usage: %d KiB RSS", int64(math.Round(bytes/1024)))
	}
	return fmt.Sprintf("Approx. Resource Usage: %d MiB RSS", int64(math.Round(bytes/1024/1024)))
}

func sessionLabel(session browser.CdpSessionObservation) string {
	address, agent := "unknown", ""
	if session.RemoteAddress != nil {
		address = *session.RemoteAddress
	}
	if session.UserAgent != nil {
		agent = *session.UserAgent
	}
	return strings.TrimSpace(formatDuration(session.DurationMs) + " " + address + " " + agent)
}

func formatDuration(ms int64) string {
	seconds := ms / 1000
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	return fmt.Sprintf("%dm", seconds/60)
}
