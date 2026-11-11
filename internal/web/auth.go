package web

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const adminCookie = "cloakhub_auth"

func tokensMatch(actual, expected string) bool {
	if decoded, err := url.PathUnescape(actual); err == nil {
		actual = decoded
	}
	return len(actual) == len(expected) && subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

func cookieToken(r *http.Request) (string, bool) {
	for _, part := range strings.Split(r.Header.Get("Cookie"), ";") {
		part = strings.TrimSpace(part)
		name, value, _ := strings.Cut(part, "=")
		if name == adminCookie {
			return value, true
		}
	}
	return "", false
}

func (s *Server) uiAuthorized(r *http.Request) bool {
	if s.config.AuthToken == "" {
		return true
	}
	token, ok := cookieToken(r)
	return ok && tokensMatch(token, s.config.AuthToken)
}

func (s *Server) adminAuthorized(r *http.Request) bool {
	if s.config.AuthToken == "" {
		return true
	}
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") {
		return false
	}
	token := strings.TrimSpace(authorization[len("Bearer "):])
	return token != "" && tokensMatch(token, s.config.AuthToken)
}

func unauthorized() *response {
	return textResponse("Unauthorized", 401, map[string]string{"WWW-Authenticate": "Bearer"})
}

func (s *Server) login(r *http.Request) *response {
	if r.Method != http.MethodPost {
		return textResponse("Method not allowed", 405, map[string]string{"Allow": "POST"})
	}
	if s.config.AuthToken == "" {
		return emptyResponse(204, nil)
	}
	var body struct {
		Token *string `json:"token"`
	}
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if json.Unmarshal(raw, &body) != nil || body.Token == nil || !tokensMatch(*body.Token, s.config.AuthToken) {
		return unauthorized()
	}
	cookie := adminCookie + "=" + url.QueryEscape(s.config.AuthToken) + "; HttpOnly; Path=/; SameSite=Lax"
	return emptyResponse(204, map[string]string{"Cache-Control": "no-store", "Set-Cookie": strings.ReplaceAll(cookie, "+", "%20")})
}
