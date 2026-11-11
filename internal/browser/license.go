package browser

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/txchen/cloakhub/internal/config"
)

// LoadLicenseKeys reads CloakBrowser keys for a licensed browser build. Keys stay
// out of configuration, profile records and launch arguments.
func LoadLicenseKeys(env func(string) string, home string) ([]string, error) {
	if env == nil {
		env = os.Getenv
	}
	var keys []string
	switch {
	case strings.TrimSpace(env("CLOAKHUB_LICENSE_KEYS")) != "":
		var raw []any
		if err := json.Unmarshal([]byte(env("CLOAKHUB_LICENSE_KEYS")), &raw); err != nil {
			return nil, &config.Error{Message: "CLOAKHUB_LICENSE_KEYS must be a JSON array of nonempty strings"}
		}
		for _, entry := range raw {
			key, ok := entry.(string)
			if !ok {
				return nil, &config.Error{Message: "License configuration must contain nonempty keys"}
			}
			keys = append(keys, key)
		}
	case strings.TrimSpace(env("CLOAKHUB_LICENSE_KEYS_FILE")) != "":
		raw, err := os.ReadFile(strings.TrimSpace(env("CLOAKHUB_LICENSE_KEYS_FILE")))
		if err != nil {
			return nil, &config.Error{Message: "Cannot read CLOAKHUB_LICENSE_KEYS_FILE"}
		}
		for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				keys = append(keys, line)
			}
		}
	case strings.TrimSpace(env("CLOAKBROWSER_LICENSE_KEY")) != "":
		keys = []string{strings.TrimSpace(env("CLOAKBROWSER_LICENSE_KEY"))}
	default:
		raw, err := os.ReadFile(filepath.Join(home, ".cloakbrowser", "license.key"))
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, &config.Error{Message: "Cannot read ~/.cloakbrowser/license.key"}
		}
		if key := strings.TrimSpace(string(raw)); key != "" {
			keys = []string{key}
		} else {
			return nil, nil
		}
	}
	if len(keys) == 0 {
		return nil, &config.Error{Message: "License configuration must contain nonempty keys"}
	}
	seen := map[string]bool{}
	var unique []string
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, &config.Error{Message: "License configuration must contain nonempty keys"}
		}
		if !seen[key] {
			seen[key] = true
			unique = append(unique, key)
		}
	}
	return unique, nil
}

// Seats is a key's upstream session count and quota.
type Seats struct {
	Active int `json:"active"`
	Limit  int `json:"limit"`
}

// QuerySeats asks the CloakBrowser license service for a key's quota.
func QuerySeats(key string) (Seats, error) {
	body, _ := json.Marshal(map[string]string{"license_key": key})
	client := http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect") },
	}
	fail := &CapacityError{Message: "CloakBrowser license quota unavailable or key rejected; check keys and retry"}
	response, err := client.Post("https://cloakbrowser.dev/api/license/session/count", "application/json", bytes.NewReader(body))
	if err != nil {
		return Seats{}, fail
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return Seats{}, fail
	}
	var seats Seats
	// Never relay upstream bodies or errors: they may contain credentials.
	if json.NewDecoder(response.Body).Decode(&seats) != nil || seats.Active < 0 || seats.Limit < 1 {
		return Seats{}, fail
	}
	return seats, nil
}

type licenseEntry struct {
	key                   string
	used, limit, external int
}

// LicensePool hands out license seats across keys.
type LicensePool struct {
	// acquire serializes query + reservation so simultaneous starts cannot claim
	// the same local seat.
	acquire  sync.Mutex
	mu       sync.Mutex
	entries  []*licenseEntry
	cursor   int
	query    func(string) (Seats, error)
	Capacity int
}

// LicenseLease is one reserved seat.
type LicenseLease struct {
	Key     string
	pool    *LicensePool
	entry   *licenseEntry
	release sync.Once
}

// Release returns the seat; extra calls are ignored.
func (l *LicenseLease) Release() {
	l.release.Do(func() {
		l.pool.mu.Lock()
		l.entry.used--
		l.pool.mu.Unlock()
	})
}

// NewLicensePool queries every key's quota once to size the pool.
func NewLicensePool(keys []string, query func(string) (Seats, error)) (*LicensePool, error) {
	if query == nil {
		query = QuerySeats
	}
	pool := &LicensePool{query: query}
	seen := map[string]bool{}
	for _, key := range keys {
		if !seen[key] {
			seen[key] = true
			pool.entries = append(pool.entries, &licenseEntry{key: key})
		}
	}
	states := pool.queryAll()
	for i, state := range states {
		if state.err == nil {
			pool.entries[i].limit = state.seats.Limit
			pool.Capacity += state.seats.Limit
		}
	}
	if pool.Capacity == 0 {
		return nil, &CapacityError{Message: "No usable CloakBrowser license quota; check keys and connectivity"}
	}
	return pool, nil
}

type seatState struct {
	seats Seats
	err   error
}

func (p *LicensePool) queryAll() []seatState {
	states := make([]seatState, len(p.entries))
	var wg sync.WaitGroup
	for i, entry := range p.entries {
		wg.Add(1)
		go func(i int, key string) {
			defer wg.Done()
			seats, err := p.query(key)
			states[i] = seatState{seats, err}
		}(i, entry.key)
	}
	wg.Wait()
	return states
}

// Acquire reserves a seat on the next key with free quota.
func (p *LicensePool) Acquire() (*LicenseLease, error) {
	p.acquire.Lock()
	defer p.acquire.Unlock()
	states := p.queryAll()
	p.mu.Lock()
	defer p.mu.Unlock()
	reachable := false
	for offset := range p.entries {
		index := (p.cursor + offset) % len(p.entries)
		entry, state := p.entries[index], states[index]
		if state.err != nil {
			continue
		}
		reachable = true
		// Upstream counts can lag a launch; local reservations cover that window.
		if entry.used == 0 {
			entry.external = state.seats.Active
		} else {
			entry.external = max(entry.external, state.seats.Active-entry.used)
		}
		if entry.used+entry.external >= state.seats.Limit {
			continue
		}
		entry.used++
		p.cursor = (index + 1) % len(p.entries)
		return &LicenseLease{Key: entry.key, pool: p, entry: entry}, nil
	}
	if !reachable {
		return nil, &CapacityError{Message: "CloakBrowser license quota unavailable or keys rejected; retry later"}
	}
	return nil, &CapacityError{Message: "CloakBrowser license capacity is full; retry after a Browser Instance stops"}
}
