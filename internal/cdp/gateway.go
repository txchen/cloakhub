// Package cdp exposes each profile's private CDP endpoint through CloakHub:
// authorization, Transparent Recovery (wake on use), discovery URL rewriting and a
// WebSocket relay that protects the last tab from being closed.
package cdp

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/profile"
)

// ErrUnauthorized means the CDP Token is missing or wrong.
var ErrUnauthorized = errors.New("CDP access is unauthorized")

// ErrCloseOverHTTP rejects Chromium's HTTP tab-close endpoint.
var ErrCloseOverHTTP = errors.New("Close tabs through CDP Target.closeTarget or Page.close")

// Runtime is the part of the browser runtime the gateway needs.
type Runtime interface {
	Start(profileID string) (browser.State, error)
	RecordCdpDiscovery(profileID string) error
}

// Gateway serves CDP discovery and prepares WebSocket relays.
type Gateway struct {
	Runtime  Runtime
	Profiles interface{ Get(string) *profile.Profile }
	// GetJSON fetches a browser CDP HTTP path; tests replace it.
	GetJSON func(cdpPort int, path string) (any, error)
}

// Authorize checks the profile's CDP Token, if one is configured.
func (g *Gateway) Authorize(r *http.Request, profileID string) bool {
	if g.Profiles == nil {
		return true
	}
	p := g.Profiles.Get(profileID)
	if p == nil || p.Token() == "" {
		return true
	}
	return BearerToken(r) == p.Token() || r.URL.Query().Get("token") == p.Token()
}

// BearerToken returns the request's bearer token, if any.
func BearerToken(r *http.Request) string {
	if match := bearerPattern.FindStringSubmatch(r.Header.Get("Authorization")); match != nil {
		return match[1]
	}
	return ""
}

var bearerPattern = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)

func (g *Gateway) getJSON(port int, path string) (any, error) {
	if g.GetJSON != nil {
		return g.GetJSON(port, path)
	}
	client := http.Client{Timeout: 10 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + path)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("Browser CDP endpoint returned %d", response.StatusCode)
	}
	decoder := json.NewDecoder(response.Body)
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

// Discovery wakes the profile and returns rewritten discovery JSON. publicURL is
// the externally visible request URL.
func (g *Gateway) Discovery(r *http.Request, publicURL *url.URL, profileID, cdpPath string) (any, error) {
	if !g.Authorize(r, profileID) {
		return nil, ErrUnauthorized
	}
	// Chromium's HTTP close endpoint would bypass the WebSocket protection queue.
	if strings.HasPrefix(cdpPath, "/json/close/") {
		return nil, ErrCloseOverHTTP
	}
	state, err := g.Runtime.Start(profileID)
	if err != nil {
		return nil, err
	}
	path := cdpPath
	if path == "/json/list" {
		path = "/json"
	}
	discovery, err := g.getJSON(state.CdpPort, path)
	if err != nil {
		return nil, err
	}
	_ = g.Runtime.RecordCdpDiscovery(profileID)
	return rewriteDiscovery(discovery, publicURL, profileID), nil
}

// Target is where a CDP WebSocket connection is relayed.
type Target struct {
	ProfileID string
	// BrowserURL is the browser-level CDP WebSocket used for tab protection.
	BrowserURL string
	// URL is the WebSocket the client connects through to.
	URL string
}

// WebSocketTarget wakes the profile and resolves the relay target.
func (g *Gateway) WebSocketTarget(r *http.Request, profileID, cdpPath string) (Target, error) {
	if !g.Authorize(r, profileID) {
		return Target{}, ErrUnauthorized
	}
	state, err := g.Runtime.Start(profileID)
	if err != nil {
		return Target{}, err
	}
	version, err := g.getJSON(state.CdpPort, "/json/version")
	if err != nil {
		return Target{}, err
	}
	browserURL := fmt.Sprintf("ws://127.0.0.1:%d/devtools/browser", state.CdpPort)
	if record, ok := version.(map[string]any); ok {
		if value, ok := record["webSocketDebuggerUrl"].(string); ok {
			browserURL = value
		}
	}
	target := Target{ProfileID: profileID, BrowserURL: browserURL, URL: browserURL}
	if cdpPath != "/json/version" {
		target.URL = fmt.Sprintf("ws://127.0.0.1:%d%s", state.CdpPort, cdpPath)
	}
	return target, nil
}

var routePattern = regexp.MustCompile(`^/api/profiles/([^/]+)/cdp(?:/(.*))?$`)

// ParseRoute matches /api/profiles/{id}/cdp[/path] on an escaped path.
func ParseRoute(escapedPath string) (profileID, cdpPath string, ok bool, err error) {
	match := routePattern.FindStringSubmatch(escapedPath)
	if match == nil {
		return "", "", false, nil
	}
	cdpPath = "/json/version"
	if match[2] != "" {
		cdpPath = "/" + match[2]
	}
	profileID, err = url.PathUnescape(match[1])
	return profileID, cdpPath, true, err
}

func rewriteDiscovery(value any, publicURL *url.URL, profileID string) any {
	switch v := value.(type) {
	case []any:
		for i, entry := range v {
			v[i] = rewriteDiscovery(entry, publicURL, profileID)
		}
		return v
	case map[string]any:
		for key, entry := range v {
			s, isString := entry.(string)
			switch {
			case key == "webSocketDebuggerUrl" && isString:
				v[key] = rewriteWebSocketURL(s, publicURL, profileID)
			case key == "devtoolsFrontendUrl" && isString:
				v[key] = rewriteFrontendURL(s, publicURL, profileID)
			default:
				v[key] = rewriteDiscovery(entry, publicURL, profileID)
			}
		}
		return v
	}
	return value
}

func rewriteWebSocketURL(value string, publicURL *url.URL, profileID string) string {
	original, err := url.Parse(value)
	if err != nil {
		return value
	}
	scheme := "ws"
	if publicURL.Scheme == "https" {
		scheme = "wss"
	}
	query := original.Query()
	if token := publicURL.Query().Get("token"); token != "" && !query.Has("token") {
		query.Set("token", token)
		original.RawQuery = query.Encode()
	}
	search := ""
	if original.RawQuery != "" {
		search = "?" + original.RawQuery
	}
	return scheme + "://" + publicURL.Host + "/api/profiles/" + url.PathEscape(profileID) + "/cdp" + original.EscapedPath() + search
}

func rewriteFrontendURL(value string, publicURL *url.URL, profileID string) string {
	frontend, err := url.Parse(value)
	if err != nil {
		return value
	}
	query := frontend.Query()
	if ws := query.Get("ws"); ws != "" {
		rewritten := rewriteWebSocketURL("ws://"+ws, publicURL, profileID)
		rewritten = strings.TrimPrefix(strings.TrimPrefix(rewritten, "wss://"), "ws://")
		query.Set("ws", rewritten)
		frontend.RawQuery = query.Encode()
	}
	search := ""
	if frontend.RawQuery != "" {
		search = "?" + frontend.RawQuery
	}
	path := frontend.EscapedPath()
	if path == "" {
		path = "/"
	}
	return path + search
}
