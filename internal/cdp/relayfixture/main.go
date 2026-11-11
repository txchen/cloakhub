// Command relayfixture serves CloakHub's CDP relay in front of an existing browser
// for the opt-in Playwright integration tests (tests/*.integration.test.*).
//
//	relayfixture -browser ws://127.0.0.1:9222/devtools/browser/ID [-profile research]
//	             [-token secret] [-pages http://127.0.0.1:8000]
//
// It prints "listening PORT" once ready. GET /__stats reports how many CDP
// connections authenticated and how many protective blank tabs were created.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"

	"github.com/txchen/cloakhub/internal/cdp"
)

func main() {
	browserURL := flag.String("browser", "", "browser-level CDP WebSocket URL")
	profileID := flag.String("profile", "work", "profile ID in /api/profiles/{id}/cdp")
	token := flag.String("token", "", "required bearer token (optional)")
	pages := flag.String("pages", "", "origin that serves non-CDP paths (optional)")
	flag.Parse()
	browser, err := url.Parse(*browserURL)
	if err != nil || browser.Host == "" {
		log.Fatal("-browser must be a WebSocket URL")
	}
	var authenticated, protections atomic.Int64
	relay := &cdp.Relay{Guard: &cdp.TabGuard{OnBlankTab: func(string) { protections.Add(1) }}}
	var static http.Handler = http.NotFoundHandler()
	if *pages != "" {
		origin, err := url.Parse(*pages)
		if err != nil {
			log.Fatal(err)
		}
		static = httputil.NewSingleHostReverseProxy(origin)
	}
	cdpPath := "/api/profiles/" + *profileID + "/cdp"
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__stats" {
			json.NewEncoder(w).Encode(map[string]int64{"authenticated": authenticated.Load(), "protections": protections.Load()})
			return
		}
		upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		target := cdp.Target{ProfileID: *profileID, BrowserURL: *browserURL, URL: *browserURL}
		switch {
		case r.URL.Path == cdpPath || r.URL.Path == "/":
		case strings.HasPrefix(r.URL.Path, "/devtools/page/"):
			target.URL = "ws://" + browser.Host + r.URL.Path
		default:
			static.ServeHTTP(w, r)
			return
		}
		if *token != "" && r.Header.Get("Authorization") != "Bearer "+*token {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if !upgrade {
			http.Error(w, "WebSocket required", http.StatusBadRequest)
			return
		}
		authenticated.Add(1)
		relay.Serve(w, r, target, "127.0.0.1")
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("listening %d\n", listener.Addr().(*net.TCPAddr).Port)
	log.Fatal(http.Serve(listener, handler))
}
