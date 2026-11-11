package cdp

import (
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// TargetInfo describes a CDP target.
type TargetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	Subtype  string `json:"subtype,omitempty"`
}

// TabGuard keeps a profile from losing its last tab: before a close that would
// leave no page, it opens about:blank. One close queue per profile is shared by all
// external CDP connections.
type TabGuard struct {
	// OnBlankTab is called after a protective blank tab is created.
	OnBlankTab func(profileID string)
	// Dial opens a browser-level control connection; tests replace it.
	Dial func(url string) (Control, error)

	mu      sync.Mutex
	queues  map[string]*sync.Mutex
	closing map[string]*closingState
}

type closingState struct {
	browserURL string
	targets    map[string]bool
}

// Control is a short-lived internal CDP connection. It never counts as an
// external sleep blocker.
type Control interface {
	Send(method string, params map[string]any) (json.RawMessage, error)
	Close()
}

func (g *TabGuard) queue(profileID string) *sync.Mutex {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.queues == nil {
		g.queues = map[string]*sync.Mutex{}
		g.closing = map[string]*closingState{}
	}
	q := g.queues[profileID]
	if q == nil {
		q = &sync.Mutex{}
		g.queues[profileID] = q
	}
	return q
}

var errProtection = errors.New("Tab protection CDP command failed")

// Close runs close for targetID, first creating a blank tab if targetID is the
// last ordinary page.
func (g *TabGuard) Close(profileID, browserURL, targetID string, close func() (Reply, error)) (Reply, error) {
	q := g.queue(profileID)
	q.Lock()
	defer q.Unlock()
	dial := g.Dial
	if dial == nil {
		dial = DialControl
	}
	control, err := dial(browserURL)
	if err != nil {
		return Reply{}, err
	}
	defer control.Close()
	raw, err := control.Send("Target.getTargets", map[string]any{})
	if err != nil {
		return Reply{}, err
	}
	var targets struct {
		TargetInfos []TargetInfo `json:"targetInfos"`
	}
	if json.Unmarshal(raw, &targets) != nil {
		return Reply{}, errProtection
	}
	g.mu.Lock()
	state := g.closing[profileID]
	if state == nil || state.browserURL != browserURL {
		// A successful close can acknowledge before targetDestroyed, or wait for
		// beforeunload. Exclude those targets from the next count; an extra blank
		// tab is safer than an exit.
		state = &closingState{browserURL: browserURL, targets: map[string]bool{}}
		g.closing[profileID] = state
	}
	ids := map[string]bool{}
	for _, t := range targets.TargetInfos {
		ids[t.TargetID] = true
	}
	for id := range state.targets {
		if !ids[id] {
			delete(state.targets, id)
		}
	}
	var target *TargetInfo
	others := 0
	for i, t := range targets.TargetInfos {
		if t.TargetID == targetID {
			target = &targets.TargetInfos[i]
		} else if t.Type == "page" && t.Subtype == "" && !state.targets[t.TargetID] {
			others++
		}
	}
	g.mu.Unlock()
	if target != nil && target.Type == "page" && target.Subtype == "" && others == 0 {
		if _, err := control.Send("Target.createTarget", map[string]any{"url": "about:blank"}); err != nil {
			return Reply{}, err
		}
		if g.OnBlankTab != nil {
			g.OnBlankTab(profileID)
		}
	}
	// Reserve before dispatch: even a timed-out or disconnected close may still finish.
	if target != nil && target.Type == "page" {
		g.mu.Lock()
		state.targets[targetID] = true
		g.mu.Unlock()
	}
	response, err := close()
	failed := err != nil || len(response.Error) > 0
	if !failed && len(response.Result) > 0 {
		var result struct {
			Success *bool `json:"success"`
		}
		if json.Unmarshal(response.Result, &result) == nil && result.Success != nil && !*result.Success {
			failed = true
		}
	}
	if failed {
		g.mu.Lock()
		delete(state.targets, targetID)
		g.mu.Unlock()
	}
	return response, err
}

type control struct {
	conn    *websocket.Conn
	mu      sync.Mutex
	nextID  int
	pending map[int]chan controlReply
	closed  chan struct{}
	once    sync.Once
}

type controlReply struct {
	result json.RawMessage
	err    error
}

// DialControl opens a browser-level CDP control connection with a 10 s budget.
func DialControl(url string) (Control, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return nil, errors.New("Tab protection CDP connection failed")
	}
	_ = conn.NetConn().SetDeadline(time.Now().Add(10 * time.Second))
	c := &control{conn: conn, nextID: 1, pending: map[int]chan controlReply{}, closed: make(chan struct{})}
	go c.read()
	return c, nil
}

func (c *control) read() {
	defer c.Close()
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var message struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(data, &message) != nil || message.ID == nil {
			continue
		}
		c.mu.Lock()
		reply := c.pending[*message.ID]
		delete(c.pending, *message.ID)
		c.mu.Unlock()
		if reply == nil {
			continue
		}
		if len(message.Error) > 0 {
			reply <- controlReply{err: errProtection}
		} else {
			result := message.Result
			if len(result) == 0 {
				result = json.RawMessage(`{}`)
			}
			reply <- controlReply{result: result}
		}
	}
}

func (c *control) Send(method string, params map[string]any) (json.RawMessage, error) {
	reply := make(chan controlReply, 1)
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	c.pending[id] = reply
	payload, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	err := c.conn.WriteMessage(websocket.TextMessage, payload)
	c.mu.Unlock()
	if err != nil {
		return nil, errors.New("Tab protection CDP connection failed")
	}
	select {
	case r := <-reply:
		return r.result, r.err
	case <-c.closed:
		return nil, errors.New("Tab protection CDP connection failed")
	}
}

func (c *control) Close() {
	c.once.Do(func() {
		close(c.closed)
		_ = c.conn.Close()
	})
}

func itoa64(value int64) string { return strconv.FormatInt(value, 10) }
