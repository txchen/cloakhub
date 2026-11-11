package browser

import (
	"slices"
	"sync"
	"time"

	"github.com/txchen/cloakhub/internal/config"
	"github.com/txchen/cloakhub/internal/profile"
)

// CapacityError means the Running Instance Limit (or license quota) is full.
type CapacityError struct{ Message string }

func (e *CapacityError) Error() string {
	if e.Message == "" {
		return "Running Instance capacity is full; retry after another Browser Instance stops"
	}
	return e.Message
}

// Reservation is the set of internal resources held for one launch.
type Reservation struct {
	CdpPort       int
	Display       string
	DisplayNumber int
	ViewerPort    int
}

// RunningSnapshot describes a running instance for capacity decisions.
type RunningSnapshot struct {
	ActiveCdpSessions int
	CdpPort           int
	DisplayNumber     int
	ViewerPort        int
	LastActivity      time.Time
	LastManualInput   time.Time
	Profile           *profile.Profile
}

// capacityManualInputProtection keeps a recently hand-used instance from preemption.
const capacityManualInputProtection = 60 * time.Second

// Capacity allocates ports and displays and enforces the Running Instance Limit,
// preempting the least-recently-active eligible instance when full.
type Capacity struct {
	mu           sync.Mutex
	preemptMu    sync.Mutex
	reservations map[string]Reservation
	max          int
	now          func() time.Time
	nextCdp      int
	nextDisplay  int
	nextViewer   int
}

// CapacityOptions configure a Capacity.
type CapacityOptions struct {
	CdpPortStart, DisplayNumberStart, ViewerPortStart int
	MaxRunningInstances                               int
	Now                                               func() time.Time
}

// NewCapacity returns a Capacity.
func NewCapacity(options CapacityOptions) *Capacity {
	c := &Capacity{
		reservations: map[string]Reservation{},
		max:          options.MaxRunningInstances,
		now:          options.Now,
		nextCdp:      options.CdpPortStart,
		nextDisplay:  options.DisplayNumberStart,
		nextViewer:   options.ViewerPortStart,
	}
	if c.max == 0 {
		c.max = config.DefaultMaxRunningInstances
	}
	if c.now == nil {
		c.now = time.Now
	}
	if c.nextCdp == 0 {
		c.nextCdp = config.CdpPortRange.Start
	}
	if c.nextDisplay == 0 {
		c.nextDisplay = config.DisplayNumberRange.Start
	}
	if c.nextViewer == 0 {
		c.nextViewer = config.ViewerPortRange.Start
	}
	return c
}

// Release returns a profile's reservation.
func (c *Capacity) Release(profileID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.reservations, profileID)
}

// Reserve allocates resources for p, preempting another instance if needed.
func (c *Capacity) Reserve(p *profile.Profile, running func() []RunningSnapshot, preempt func(*profile.Profile) error) (Reservation, error) {
	c.mu.Lock()
	if c.reservedCount(running()) < c.max {
		reservation, err := c.reserveLocked(p, running())
		c.mu.Unlock()
		return reservation, err
	}
	c.mu.Unlock()

	// Preemption is serialized so simultaneous starts reserve only one slot each.
	c.preemptMu.Lock()
	defer c.preemptMu.Unlock()
	c.mu.Lock()
	full := c.reservedCount(running()) >= c.max
	c.mu.Unlock()
	if full {
		candidate := c.preemptionCandidate(p.ProfileID, running())
		if candidate == nil {
			return Reservation{}, &CapacityError{}
		}
		if err := preempt(candidate.Profile); err != nil {
			return Reservation{}, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	instances := running()
	if c.reservedCount(instances) >= c.max {
		return Reservation{}, &CapacityError{}
	}
	return c.reserveLocked(p, instances)
}

func (c *Capacity) preemptionCandidate(requested string, running []RunningSnapshot) *RunningSnapshot {
	var eligible []RunningSnapshot
	for _, r := range running {
		if r.Profile.ProfileID != requested && c.eligible(r) {
			eligible = append(eligible, r)
		}
	}
	if len(eligible) == 0 {
		return nil
	}
	slices.SortStableFunc(eligible, func(a, b RunningSnapshot) int {
		return activityTimestamp(a).Compare(activityTimestamp(b))
	})
	return &eligible[0]
}

func (c *Capacity) eligible(r RunningSnapshot) bool {
	if r.ActiveCdpSessions > 0 {
		return false
	}
	if !r.LastManualInput.IsZero() {
		return c.now().Sub(r.LastManualInput) >= capacityManualInputProtection
	}
	persisted, ok := parseTimestamp(r.Profile.LastManualInputAt)
	return !ok || c.now().Sub(persisted) >= capacityManualInputProtection
}

func activityTimestamp(r RunningSnapshot) time.Time {
	observed := r.LastActivity
	if r.LastManualInput.After(observed) {
		observed = r.LastManualInput
	}
	if !observed.IsZero() {
		return observed
	}
	latest := time.Unix(0, 0)
	if t, ok := parseTimestamp(r.Profile.LastActivityAt); ok && t.After(latest) {
		latest = t
	}
	if t, ok := parseTimestamp(r.Profile.LastManualInputAt); ok && t.After(latest) {
		latest = t
	}
	return latest
}

func (c *Capacity) reservedCount(running []RunningSnapshot) int {
	ids := map[string]bool{}
	for _, r := range running {
		ids[r.Profile.ProfileID] = true
	}
	for id := range c.reservations {
		ids[id] = true
	}
	return len(ids)
}

func (c *Capacity) reserveLocked(p *profile.Profile, running []RunningSnapshot) (Reservation, error) {
	usedCdp, usedDisplay, usedViewer := map[int]bool{}, map[int]bool{}, map[int]bool{}
	for _, r := range running {
		usedCdp[r.CdpPort] = true
		usedDisplay[r.DisplayNumber] = true
		usedViewer[r.ViewerPort] = true
	}
	for _, r := range c.reservations {
		usedCdp[r.CdpPort] = true
		usedDisplay[r.DisplayNumber] = true
		usedViewer[r.ViewerPort] = true
	}
	cdpPort, ok := nextAvailable(config.CdpPortRange, usedCdp, c.nextCdp)
	if !ok {
		return Reservation{}, &CapacityError{}
	}
	reservation := Reservation{CdpPort: cdpPort}
	if !p.Headless {
		displayNumber, ok1 := nextAvailable(config.DisplayNumberRange, usedDisplay, c.nextDisplay)
		viewerPort, ok2 := nextAvailable(config.ViewerPortRange, usedViewer, c.nextViewer)
		if !ok1 || !ok2 {
			return Reservation{}, &CapacityError{}
		}
		reservation.DisplayNumber = displayNumber
		reservation.Display = ":" + itoa(displayNumber)
		reservation.ViewerPort = viewerPort
		c.nextDisplay = after(displayNumber, config.DisplayNumberRange)
		c.nextViewer = after(viewerPort, config.ViewerPortRange)
	}
	c.nextCdp = after(cdpPort, config.CdpPortRange)
	c.reservations[p.ProfileID] = reservation
	return reservation, nil
}

func nextAvailable(r config.Range, used map[int]bool, preferred int) (int, bool) {
	candidate := preferred
	if candidate < r.Start || candidate > r.End {
		candidate = r.Start
	}
	for checked := 0; checked < r.Size(); checked++ {
		if !used[candidate] {
			return candidate, true
		}
		candidate = after(candidate, r)
	}
	return 0, false
}

func after(value int, r config.Range) int {
	if value >= r.End {
		return r.Start
	}
	return value + 1
}

func parseTimestamp(value *string) (time.Time, bool) {
	if value == nil || *value == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, *value)
	return t, err == nil
}
