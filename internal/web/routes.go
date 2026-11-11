package web

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/txchen/cloakhub/internal/browser"
	"github.com/txchen/cloakhub/internal/cdp"
	"github.com/txchen/cloakhub/internal/profile"
)

func (s *Server) cdpRoute(w http.ResponseWriter, r *http.Request, path string) (*response, bool) {
	profileID, cdpPath, ok, err := cdp.ParseRoute(path)
	if !ok {
		return nil, false
	}
	if err != nil {
		return apiError("Invalid URL encoding", 400, "", false, nil), true
	}
	if s.gateway == nil {
		return textResponse("Not found", 404, nil), true
	}
	requestTokens := func() []string {
		var tokens []string
		if token := r.URL.Query().Get("token"); token != "" {
			tokens = append(tokens, token)
		}
		if bearer := cdp.BearerToken(r); bearer != "" {
			tokens = append(tokens, bearer)
		}
		return tokens
	}
	if isWebSocketUpgrade(r) {
		target, err := s.gateway.WebSocketTarget(r, profileID, cdpPath)
		if err != nil {
			if errors.Is(err, cdp.ErrUnauthorized) {
				return unauthorized(), true
			}
			return runtimeError(err, "CDP_UNAVAILABLE", 503, requestTokens()), true
		}
		if s.relay == nil {
			return apiError("CDP websocket upgrade is unavailable", 400, "", false, nil), true
		}
		s.relay.Serve(w, r, target, remoteAddress(r))
		return nil, true
	}
	if r.Method != http.MethodGet {
		return methodNotAllowed("GET"), true
	}
	discovery, err := s.gateway.Discovery(r, publicURL(r), profileID, cdpPath)
	switch {
	case err == nil:
		return jsonResponse(discovery, 200, nil), true
	case errors.Is(err, cdp.ErrUnauthorized):
		return unauthorized(), true
	case errors.Is(err, cdp.ErrCloseOverHTTP):
		return apiError(err.Error(), 405, "METHOD_NOT_ALLOWED", false, nil), true
	}
	return runtimeError(err, "CDP_UNAVAILABLE", 503, append(requestTokens(), s.tokensForRedaction()...)), true
}

var cdpTokenPath = regexp.MustCompile(`^/(?:api|ui)/profiles/([^/]+)/cdp-token(?:/(regenerate))?$`)

func (s *Server) cdpTokenRoute(r *http.Request, path string) *response {
	match := cdpTokenPath.FindStringSubmatch(path)
	if match == nil {
		return nil
	}
	if s.profiles == nil {
		return textResponse("Not found", 404, nil)
	}
	profileID, action := match[1], match[2]
	var (
		state profile.TokenState
		err   error
	)
	switch {
	case action == "" && r.Method == http.MethodGet:
		state, err = s.profiles.GetCdpToken(profileID)
		if err == nil {
			return jsonResponse(state, 200, nil)
		}
	case action == "" && r.Method == http.MethodPost:
		state, err = s.profiles.CreateCdpToken(profileID)
		if err == nil {
			return jsonResponse(state, 201, nil)
		}
	case action == "regenerate" && r.Method == http.MethodPost:
		state, err = s.profiles.RegenerateCdpToken(profileID)
		if err == nil {
			return jsonResponse(state, 200, nil)
		}
	case action == "" && r.Method == http.MethodDelete:
		if err = s.profiles.RevokeCdpToken(profileID); err == nil {
			return emptyResponse(204, nil)
		}
	default:
		allow := "GET, POST, DELETE"
		if action == "regenerate" {
			allow = "POST"
		}
		return methodNotAllowed(allow)
	}
	return profileError(err)
}

var clipboardPath = regexp.MustCompile(`^/ui/profiles/([^/]+)/clipboard$`)

func (s *Server) clipboardRoute(r *http.Request, path string) *response {
	match := clipboardPath.FindStringSubmatch(path)
	if match == nil {
		return nil
	}
	if s.runtime == nil {
		return textResponse("Not found", 404, nil)
	}
	switch r.Method {
	case http.MethodGet:
		text, err := s.runtime.ReadManualClipboard(match[1])
		if err != nil {
			return viewerJSONError(err)
		}
		if len(text) > 1_048_576 {
			text = text[:1_048_576]
		}
		return jsonResponse(map[string]string{"text": text}, 200, nil)
	case http.MethodPost:
	default:
		return methodNotAllowed("GET, POST")
	}
	body, err := profile.DecodeObject(readBody(r))
	if err != nil && strings.Contains(err.Error(), "valid JSON") {
		return apiError("Request body must be valid JSON", 400, "", false, nil)
	}
	text, ok := body["text"].(string)
	if err != nil || !ok {
		return apiError("clipboard text is required", 400, "", false, nil)
	}
	if err := s.runtime.WriteManualClipboard(match[1], text); err != nil {
		return viewerJSONError(err)
	}
	return jsonResponse(map[string]bool{"ok": true}, 200, nil)
}

var viewerPath = regexp.MustCompile(`^/ui/profiles/([^/]+)/viewer$`)

func (s *Server) viewerPage(r *http.Request, path string) *response {
	match := viewerPath.FindStringSubmatch(path)
	if match == nil {
		return nil
	}
	if s.runtime == nil {
		return textResponse("Not found", 404, nil)
	}
	if r.Method != http.MethodGet {
		return methodNotAllowed("GET")
	}
	state, err := s.runtime.OpenManualViewer(match[1])
	if err != nil {
		return viewerHTMLError(err)
	}
	return htmlResponse(renderViewer(state.ProfileID, state.DisplayPath, state.ClipboardSync), 200, nil)
}

var lifecyclePath = regexp.MustCompile(`^/(?:api|ui)/profiles/([^/]+)/(start|stop|restart)$`)

func (s *Server) lifecycleRoute(r *http.Request, path string) *response {
	match := lifecyclePath.FindStringSubmatch(path)
	if match == nil {
		return nil
	}
	if s.runtime == nil {
		return textResponse("Not found", 404, nil)
	}
	if r.Method != http.MethodPost {
		return methodNotAllowed("POST")
	}
	profileID, action := match[1], match[2]
	var (
		state browser.State
		err   error
	)
	switch action {
	case "start":
		state, err = s.runtime.Start(profileID)
	case "stop":
		state, err = s.runtime.Stop(profileID, profile.StopManual)
	default:
		state, err = s.runtime.Restart(profileID)
	}
	if err != nil {
		return runtimeError(err, "BROWSER_"+strings.ToUpper(action)+"_FAILED", 500, s.tokensForRedaction())
	}
	body := map[string]any{"profile_id": state.ProfileID, "status": state.Status, "instance_status": state.Status}
	if strings.HasPrefix(path, "/api/") && s.profiles != nil {
		if p := s.profiles.Get(profileID); p != nil {
			body["connection"] = profileConnection(p, publicURL(r))
		}
	}
	return jsonResponse(body, 200, nil)
}

var profilePath = regexp.MustCompile(`^/(?:api|ui)/profiles(?:/([^/]+))?$`)

func (s *Server) profileRoute(r *http.Request, path string) *response {
	match := profilePath.FindStringSubmatch(path)
	if match == nil {
		return nil
	}
	if s.profiles == nil {
		return textResponse("Not found", 404, nil)
	}
	profileID := match[1]
	api := strings.HasPrefix(path, "/api/")
	view := r.URL.Query().Get("view")
	hasView := r.URL.Query().Has("view")
	if api && r.Method == http.MethodGet && hasView && view != "summary" && view != "full" {
		return apiError("view must be summary or full", 400, "", false, nil)
	}
	isSummary := api && r.Method == http.MethodGet && view == "summary"
	public := publicURL(r)
	present := func(profiles []*profile.Profile) any {
		if isSummary {
			result := make([]summary, len(profiles))
			for i, p := range profiles {
				result[i] = s.summary(p)
				if api {
					result[i].Connection = profileConnection(p, public)
				}
			}
			return result
		}
		result := s.present(profiles, !api)
		if api {
			for i := range result {
				result[i].Connection = profileConnection(profiles[i], public)
			}
		}
		return result
	}
	one := func(p *profile.Profile) any {
		switch views := present([]*profile.Profile{p}).(type) {
		case []summary:
			return views[0]
		case []presented:
			return views[0]
		}
		return nil
	}
	var body map[string]any
	if r.Method == http.MethodPost || r.Method == http.MethodPatch {
		var err error
		if body, err = profile.DecodeObject(readBody(r)); err != nil {
			return profileError(err)
		}
	}
	switch {
	case profileID == "" && r.Method == http.MethodGet:
		return jsonResponse(present(s.profiles.List()), 200, nil)
	case profileID == "" && r.Method == http.MethodPost:
		created, err := s.profiles.Create(body)
		if err != nil {
			return profileError(err)
		}
		return jsonResponse(one(created), 201, nil)
	case profileID != "" && r.Method == http.MethodGet:
		p := s.profiles.Get(profileID)
		if p == nil {
			return apiError("Browser Profile was not found", 404, "PROFILE_NOT_FOUND", false, nil)
		}
		return jsonResponse(one(p), 200, nil)
	case profileID != "" && r.Method == http.MethodPatch:
		updated, err := s.profiles.Update(profileID, body)
		if err != nil {
			return profileError(err)
		}
		return jsonResponse(one(updated), 200, nil)
	case profileID != "" && r.Method == http.MethodDelete:
		var err error
		if s.runtime != nil {
			err = s.runtime.DeleteProfile(profileID, func() error { return s.profiles.DeleteStopped(profileID) })
		} else {
			err = s.profiles.DeleteStopped(profileID)
		}
		if err != nil {
			return profileError(err)
		}
		return emptyResponse(204, nil)
	}
	allow := "GET, POST"
	if profileID != "" {
		allow = "GET, PATCH, DELETE"
	}
	return methodNotAllowed(allow)
}

func profileError(err error) *response {
	message := profile.RedactSecrets(err.Error(), nil)
	var duplicate *profile.DuplicateError
	var notFound *profile.NotFoundError
	var deleteData *profile.DeleteDataError
	switch {
	case profile.IsValidation(err):
		return apiError(message, 400, "", false, nil)
	case errors.As(err, &duplicate):
		return apiError(message, 409, "PROFILE_ALREADY_EXISTS", false, nil)
	case errors.As(err, &notFound):
		return apiError(message, 404, "PROFILE_NOT_FOUND", false, nil)
	case errors.As(err, &deleteData):
		return apiError(message, 500, "DATA_DELETE_FAILED", false, nil)
	}
	panic(err)
}
