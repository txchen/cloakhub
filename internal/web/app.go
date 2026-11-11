// Package web is CloakHub's HTTP surface: the admin API, CDP gateway routes, the
// operator UI and the live viewer proxy.
package web

import (
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/cdp"
	"github.com/txchen/cloakhub/internal/config"
	"github.com/txchen/cloakhub/internal/events"
	"github.com/txchen/cloakhub/internal/procs"
	"github.com/txchen/cloakhub/internal/profile"
	"github.com/txchen/cloakhub/internal/viewer"
)

// Runtime is the browser runtime as seen by HTTP handlers.
type Runtime interface {
	ActiveCdpSessionCount(string) int
	ActiveViewerCount(string) int
	CdpSessionObservations(string) []browser.CdpSessionObservation
	LastManualInputAt(string) *string
	OpenCdpSession(profileID, remoteAddress, userAgent string) (*browser.CdpSession, error)
	OpenManualViewer(string) (browser.ViewerState, error)
	OpenViewerSession(string) (*browser.ViewerSession, error)
	ReadManualClipboard(string) (string, error)
	WriteManualClipboard(string, string) error
	Start(string) (browser.State, error)
	Stop(string, string) (browser.State, error)
	Restart(string) (browser.State, error)
	DeleteProfile(string, func() error) error
	RecordCdpDiscovery(string) error
}

// Services wires the Hub's components into the HTTP server. Nil services make
// their routes respond 404.
type Services struct {
	Events   *events.Log
	Viewer   *viewer.Store
	Runtime  Runtime
	Gateway  *cdp.Gateway
	Relay    *cdp.Relay
	Profiles *profile.Service
	Owned    *procs.Registry
}

// Server handles every CloakHub HTTP request.
type Server struct {
	config   config.Config
	events   *events.Log
	viewer   *viewer.Store
	runtime  Runtime
	gateway  *cdp.Gateway
	relay    *cdp.Relay
	profiles *profile.Service
	owned    *procs.Registry
	assets   *assets
}

// New returns a Server.
func New(cfg config.Config, services Services) *Server {
	owned := services.Owned
	if owned == nil {
		owned = procs.NewRegistry(cfg.DataRoot)
	}
	return &Server{
		config: cfg, events: services.Events, viewer: services.Viewer, runtime: services.Runtime,
		gateway: services.Gateway, relay: services.Relay, profiles: services.Profiles, owned: owned,
		assets: loadAssets(),
	}
}

// ServeHTTP routes a request. /api responses always use the API error contract.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	api := strings.HasPrefix(path, "/api/")
	var result *response
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				if recovered == http.ErrAbortHandler {
					panic(recovered)
				}
				log.Printf("panic serving %s: %v", path, recovered)
				result = apiError("An internal error occurred", 500, "", false, nil)
			}
		}()
		result = s.route(w, r, path)
	}()
	if result == nil {
		return
	}
	if api {
		result = normalizeAPIError(result)
	}
	result.write(w, r.Method == http.MethodHead)
}

var (
	viewerSettingsPath = regexp.MustCompile(`^/(?:api|ui)/viewer-settings$`)
	cdpRoutePath       = regexp.MustCompile(`^/api/profiles/[^/]+/cdp(?:/|$)`)
	uiActionPath       = regexp.MustCompile(`^/ui/profiles(?:/[^/]+(?:/(?:start|stop|restart|viewer|display/[^/]*|clipboard|cdp-token(?:/regenerate)?))?)?$`)
	displayWSPath      = regexp.MustCompile(`^/ui/profiles/[^/]+/display/ws$`)
)

func (s *Server) route(w http.ResponseWriter, r *http.Request, path string) *response {
	switch path {
	case "/api/health":
		if r.Method != http.MethodGet {
			return textResponse("Method not allowed", 405, map[string]string{"Allow": "GET"})
		}
		return jsonResponse(map[string]bool{"ok": true}, 200, map[string]string{"Cache-Control": "no-store"})
	case "/api/auth/login":
		return s.login(r)
	case "/favicon.svg":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			return textResponse("Method not allowed", 405, map[string]string{"Allow": "GET, HEAD"})
		}
		return newResponse(200, "image/svg+xml; charset=utf-8", favicon, map[string]string{"Cache-Control": "public, max-age=86400"})
	}
	if asset := s.assets.response(r, path); asset != nil {
		return asset
	}
	isCdp := cdpRoutePath.MatchString(path)
	if strings.HasPrefix(path, "/api/") && path != "/api/health" && path != "/api/auth/login" && !isCdp && !s.adminAuthorized(r) {
		return unauthorized()
	}
	if uiActionPath.MatchString(path) && !s.uiAuthorized(r) {
		return unauthorized()
	}
	if viewerSettingsPath.MatchString(path) {
		if strings.HasPrefix(path, "/ui/") && !s.uiAuthorized(r) {
			return unauthorized()
		}
		return s.viewerSettings(r)
	}
	if path == "/api/events" || path == "/ui/events" {
		if path == "/ui/events" && !s.uiAuthorized(r) {
			return unauthorized()
		}
		return s.eventLog(r)
	}
	if path == "/api/profile-defaults" || path == "/ui/profile-defaults" {
		if strings.HasPrefix(path, "/ui/") && !s.uiAuthorized(r) {
			return unauthorized()
		}
		if r.Method != http.MethodGet {
			return apiError("Method not allowed", 405, "METHOD_NOT_ALLOWED", false, map[string]string{"Allow": "GET"})
		}
		if s.profiles == nil {
			return textResponse("Not found", 404, nil)
		}
		return jsonResponse(s.profiles.CreationDefaults(), 200, map[string]string{"Cache-Control": "no-store"})
	}
	if response, handled := s.cdpRoute(w, r, path); handled {
		return response
	}
	if response := s.cdpTokenRoute(r, path); response != nil {
		return response
	}
	if response, handled := s.displayRoute(w, r, path); handled {
		return response
	}
	if response := s.clipboardRoute(r, path); response != nil {
		return response
	}
	if response := s.viewerPage(r, path); response != nil {
		return response
	}
	if response := s.lifecycleRoute(r, path); response != nil {
		return response
	}
	if response := s.profileRoute(r, path); response != nil {
		return response
	}
	if path == "/" || path == "/index.html" {
		if !s.uiAuthorized(r) {
			return htmlResponse(renderLogin(), 401, map[string]string{"WWW-Authenticate": "Bearer"})
		}
		var profiles any = []presented{}
		if s.profiles != nil {
			profiles = s.dashboardProfiles()
		}
		return htmlResponse(renderShell(profiles, s.config.MaxRunningInstances), 200, nil)
	}
	return textResponse("Not found", 404, nil)
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func readBody(r *http.Request) []byte {
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	return raw
}

func (s *Server) tokensForRedaction() []string {
	if s.profiles == nil {
		return nil
	}
	return s.profiles.TokensForRedaction()
}

// runtimeError maps runtime failures to API responses.
func runtimeError(err error, fallbackCode string, fallbackStatus int, tokens []string) *response {
	message := profile.RedactSecrets(err.Error(), tokens)
	var notFound *profile.NotFoundError
	var capacity *browser.CapacityError
	var missingDisplay *browser.MissingDisplayError
	switch {
	case errors.As(err, &notFound):
		return apiError(message, 404, "PROFILE_NOT_FOUND", false, nil)
	case errors.As(err, &capacity):
		return apiError(message, 503, "CAPACITY_UNAVAILABLE", true, nil)
	case profile.IsValidation(err):
		return apiError(message, 400, "BAD_REQUEST", false, nil)
	case errors.As(err, &missingDisplay):
		return apiError(message, 503, "DISPLAY_UNAVAILABLE", false, nil)
	}
	return apiError(message, fallbackStatus, fallbackCode, false, nil)
}

func viewerJSONError(err error) *response {
	var notFound *profile.NotFoundError
	var unsupported *browser.UnsupportedViewerError
	var missingDisplay *browser.MissingDisplayError
	var capacity *browser.CapacityError
	switch {
	case errors.As(err, &notFound):
		return apiError(err.Error(), 404, "", false, nil)
	case errors.As(err, &unsupported), errors.As(err, &missingDisplay):
		return apiError(err.Error(), 400, "", false, nil)
	case errors.As(err, &capacity):
		return apiError(err.Error(), 503, "CAPACITY_UNAVAILABLE", true, nil)
	}
	return apiError(err.Error(), 503, "", false, nil)
}

func viewerHTMLError(err error) *response {
	var notFound *profile.NotFoundError
	var unsupported *browser.UnsupportedViewerError
	var missingDisplay *browser.MissingDisplayError
	var capacity *browser.CapacityError
	switch {
	case errors.As(err, &notFound):
		return htmlResponse(renderViewerUnavailable(err.Error()), 404, nil)
	case errors.As(err, &unsupported), errors.As(err, &missingDisplay):
		return htmlResponse(renderViewerUnavailable(err.Error()), 400, nil)
	case errors.As(err, &capacity):
		return htmlResponse(renderViewerUnavailable(err.Error()+". Retryable."), 503, nil)
	}
	return htmlResponse(renderViewerUnavailable(err.Error()), 503, nil)
}

func remoteAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func methodNotAllowed(allow string) *response {
	return textResponse("Method not allowed", 405, map[string]string{"Allow": allow})
}

func (s *Server) viewerSettings(r *http.Request) *response {
	if s.viewer == nil {
		return textResponse("Not found", 404, nil)
	}
	body := func() map[string]any {
		settings := s.viewer.Get()
		return map[string]any{
			"settings": settings,
			"preset":   viewer.PresetFor(settings),
			"presets":  viewer.Presets,
			"limits":   viewer.Limits,
		}
	}
	switch r.Method {
	case http.MethodGet:
		return jsonResponse(body(), 200, map[string]string{"Cache-Control": "no-store"})
	case http.MethodPut:
	default:
		return methodNotAllowed("GET, PUT")
	}
	input, err := profile.DecodeObject(readBody(r))
	if err != nil {
		if strings.Contains(err.Error(), "valid JSON") {
			return apiError("Request body must be valid JSON", 400, "", false, nil)
		}
		return apiError("Viewer settings must be a JSON object", 400, "", false, nil)
	}
	if _, err := s.viewer.Update(input); err != nil {
		var invalid *viewer.InvalidError
		if errors.As(err, &invalid) {
			return apiError(err.Error(), 400, "", false, nil)
		}
		return apiError("An internal error occurred", 500, "", false, nil)
	}
	return jsonResponse(body(), 200, nil)
}

var timestampPrefix = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T`)
var digits = regexp.MustCompile(`^\d+$`)

func (s *Server) eventLog(r *http.Request) *response {
	if r.Method != http.MethodGet {
		return emptyResponse(405, map[string]string{"Allow": "GET"})
	}
	if s.events == nil {
		return apiError("Event log is unavailable", 503, "INTERNAL_ERROR", false, nil)
	}
	params := r.URL.Query()
	query := events.Query{ProfileID: params.Get("profile_id"), Type: params.Get("type")}
	for _, key := range []string{"since", "until"} {
		value := params.Get(key)
		if value == "" {
			continue
		}
		parsed, ok := parseJSDate(value)
		if !timestampPrefix.MatchString(value) || !ok {
			return apiError("Invalid "+key+" timestamp", 400, "BAD_REQUEST", false, nil)
		}
		iso := profile.NowISO(parsed)
		if key == "since" {
			query.Since = iso
		} else {
			query.Until = iso
		}
	}
	if query.Since != "" && query.Until != "" && query.Since > query.Until {
		return apiError("Start time must precede end time", 400, "BAD_REQUEST", false, nil)
	}
	for _, key := range []string{"before", "limit"} {
		if !params.Has(key) {
			continue
		}
		value := params.Get(key)
		number, err := strconv.ParseInt(value, 10, 64)
		if !digits.MatchString(value) || err != nil || number < 1 || number > 1<<53-1 || (key == "limit" && number > 200) {
			return apiError("Invalid "+key, 400, "BAD_REQUEST", false, nil)
		}
		if key == "before" {
			query.Before = number
		} else {
			query.Limit = number
		}
	}
	page, err := s.events.List(query)
	if err != nil {
		return apiError("An internal error occurred", 500, "", false, nil)
	}
	return jsonResponse(page, 200, map[string]string{"Cache-Control": "no-store"})
}

// parseJSDate accepts the ISO forms Date.parse accepts for event filters.
func parseJSDate(value string) (time.Time, bool) {
	layouts := []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02T15:04Z07:00"}
	for _, layout := range layouts {
		if t, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
