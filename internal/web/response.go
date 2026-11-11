package web

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

// response is a buffered HTTP response. Handlers return nil after taking over the
// connection (WebSocket upgrades).
type response struct {
	status int
	header http.Header
	body   []byte
}

func newResponse(status int, contentType string, body []byte, headers map[string]string) *response {
	r := &response{status: status, header: http.Header{}, body: body}
	if contentType != "" {
		r.header.Set("Content-Type", contentType)
	}
	for name, value := range headers {
		r.header.Set(name, value)
	}
	return r
}

func jsonResponse(value any, status int, headers map[string]string) *response {
	body, err := json.Marshal(value)
	if err != nil {
		return apiError("An internal error occurred", 500, "", false, nil)
	}
	return newResponse(status, "application/json", body, headers)
}

func textResponse(body string, status int, headers map[string]string) *response {
	return newResponse(status, "text/plain; charset=utf-8", []byte(body), headers)
}

func htmlResponse(body string, status int, headers map[string]string) *response {
	return newResponse(status, "text/html; charset=utf-8", []byte(body), headers)
}

func emptyResponse(status int, headers map[string]string) *response {
	return newResponse(status, "", nil, headers)
}

var errorCodes = map[int]string{
	400: "BAD_REQUEST",
	401: "UNAUTHORIZED",
	404: "NOT_FOUND",
	405: "METHOD_NOT_ALLOWED",
	409: "CONFLICT",
	426: "UPGRADE_REQUIRED",
	500: "INTERNAL_ERROR",
	503: "SERVICE_UNAVAILABLE",
}

type apiErrorBody struct {
	Error     string `json:"error"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// apiError is the machine-readable error contract shared by every /api route.
func apiError(message string, status int, code string, retryable bool, headers map[string]string) *response {
	if code == "" {
		code = errorCodes[status]
		if code == "" {
			code = "INTERNAL_ERROR"
		}
	}
	body, _ := json.Marshal(apiErrorBody{Error: message, Code: code, Message: message, Retryable: retryable})
	r := newResponse(status, "application/json", body, headers)
	r.header.Set("Cache-Control", "no-store")
	return r
}

// normalizeAPIError rewrites plain-text routing errors into the API error contract.
func normalizeAPIError(r *response) *response {
	if r == nil || r.status < 400 {
		return r
	}
	var body struct {
		Error     *string `json:"error"`
		Code      string  `json:"code"`
		Retryable bool    `json:"retryable"`
	}
	message := string(r.body)
	if json.Unmarshal(r.body, &body) == nil && body.Error != nil {
		message = *body.Error
	} else {
		body.Code, body.Retryable = "", false
	}
	normalized := apiError(message, r.status, body.Code, body.Retryable, nil)
	for name, values := range r.header {
		if name != "Content-Length" && name != "Content-Type" {
			normalized.header[name] = values
		}
	}
	normalized.header.Set("Content-Type", "application/json")
	normalized.header.Set("Cache-Control", "no-store")
	return normalized
}

func (r *response) write(w http.ResponseWriter, head bool) {
	for name, values := range r.header {
		w.Header()[name] = values
	}
	w.WriteHeader(r.status)
	if !head && len(r.body) > 0 {
		_, _ = w.Write(r.body)
	}
}

// publicURL is the externally visible URL of a request, honoring X-Forwarded-*.
func publicURL(r *http.Request) *url.URL {
	u := &url.URL{Scheme: "http", Host: r.Host, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
	if r.TLS != nil {
		u.Scheme = "https"
	}
	if host := r.Header.Get("X-Forwarded-Host"); host != "" {
		u.Host = strings.TrimSpace(strings.Split(host, ",")[0])
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto == "http" || proto == "https" {
		u.Scheme = proto
	}
	return u
}

func origin(u *url.URL) string { return u.Scheme + "://" + u.Host }
