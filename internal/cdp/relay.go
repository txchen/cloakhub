package cdp

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// SessionTracker registers external CDP sessions (sleep blockers).
type SessionTracker interface {
	OpenCdpSession(profileID, remoteAddress, userAgent string) (Session, error)
}

// Session is an open external CDP session.
type Session interface {
	Close()
	RecordMessage()
}

// Relay proxies client CDP WebSockets to the browser.
type Relay struct {
	Sessions SessionTracker
	Guard    *TabGuard
	Dialer   *websocket.Dialer
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	// Authorization is the CDP Token; browsers are not the expected clients.
	CheckOrigin: func(*http.Request) bool { return true },
}

// lockedConn serializes writes: gorilla allows one concurrent writer.
type lockedConn struct {
	*websocket.Conn
	mu sync.Mutex
}

func (c *lockedConn) write(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.WriteMessage(messageType, data)
}

func (c *lockedConn) closeWith(code int, reason string) {
	c.mu.Lock()
	_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	c.mu.Unlock()
	_ = c.Close()
}

// Serve upgrades the request and relays it to target until either side closes.
func (relay *Relay) Serve(w http.ResponseWriter, r *http.Request, target Target, remoteAddress string) {
	clientConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &lockedConn{Conn: clientConn}
	client.SetReadLimit(256 << 20)
	var session Session
	if relay.Sessions != nil {
		session, err = relay.Sessions.OpenCdpSession(target.ProfileID, remoteAddress, r.Header.Get("User-Agent"))
		if err != nil {
			client.closeWith(websocket.CloseInternalServerErr, "CDP websocket proxy error")
			return
		}
		defer session.Close()
	}
	dialer := relay.Dialer
	if dialer == nil {
		dialer = &websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 32 * 1024, WriteBufferSize: 32 * 1024}
	}
	upstreamConn, _, err := dialer.Dial(target.URL, nil)
	if err != nil {
		client.closeWith(websocket.CloseInternalServerErr, "CDP websocket proxy error")
		return
	}
	upstream := &lockedConn{Conn: upstreamConn}
	upstream.SetReadLimit(256 << 20)
	state := newRelayState(client, upstream, target, relay.Guard)
	defer state.dispose()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			messageType, data, err := upstream.ReadMessage()
			if err != nil {
				client.closeWith(websocket.CloseNormalClosure, "")
				return
			}
			state.receive(messageType, data)
		}
	}()
	for {
		messageType, data, err := client.ReadMessage()
		if err != nil {
			break
		}
		if session != nil {
			session.RecordMessage()
		}
		state.send(messageType, data)
	}
	_ = upstream.Close()
	<-done
}

type pendingReply struct {
	reply chan Reply
}

type relayState struct {
	client, upstream *lockedConn
	target           Target
	guard            *TabGuard

	mu       sync.Mutex
	sessions map[string]string
	pending  map[string]*pendingReply
	expired  map[string]bool
	disposed bool
}

func newRelayState(client, upstream *lockedConn, target Target, guard *TabGuard) *relayState {
	return &relayState{
		client: client, upstream: upstream, target: target, guard: guard,
		sessions: map[string]string{}, pending: map[string]*pendingReply{}, expired: map[string]bool{},
	}
}

func (s *relayState) dispose() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.disposed = true
	for key, request := range s.pending {
		close(request.reply)
		delete(s.pending, key)
	}
	s.expired = map[string]bool{}
}

// Message is the subset of a CDP message the relay inspects.
type Message struct {
	ID        *int64          `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Params    *MessageParams  `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     json.RawMessage `json:"error,omitempty"`
}

// MessageParams carries target identifiers.
type MessageParams struct {
	TargetID   string      `json:"targetId,omitempty"`
	SessionID  string      `json:"sessionId,omitempty"`
	TargetInfo *TargetInfo `json:"targetInfo,omitempty"`
}

// Reply is a CDP command result or error.
type Reply struct {
	Result json.RawMessage
	Error  json.RawMessage
}

func replyKey(sessionID string, id int64) string {
	return sessionID + ":" + itoa64(id)
}

var pagePath = regexp.MustCompile(`/devtools/page/([^/?]+)`)

// Cheap substring checks keep large messages (screenshots, DOM snapshots) off the
// JSON decoder; only candidates are parsed.
func isCloseCommand(data []byte) bool {
	return bytes.Contains(data, []byte(`"Target.closeTarget"`)) || bytes.Contains(data, []byte(`"Page.close"`))
}

func isTargetEvent(data []byte) bool {
	return bytes.Contains(data, []byte(`"Target.attachedToTarget"`)) || bytes.Contains(data, []byte(`"Target.detachedFromTarget"`))
}

func (s *relayState) send(messageType int, data []byte) {
	// Only close commands need inspection; everything else passes through untouched.
	if messageType != websocket.TextMessage || !isCloseCommand(data) {
		_ = s.upstream.write(messageType, data)
		return
	}
	var command Message
	if json.Unmarshal(data, &command) != nil || command.ID == nil ||
		(command.Method != "Target.closeTarget" && command.Method != "Page.close") || s.target.BrowserURL == "" || s.guard == nil {
		_ = s.upstream.write(messageType, data)
		return
	}
	targetID := ""
	switch {
	case command.Method == "Target.closeTarget":
		if command.Params != nil {
			targetID = command.Params.TargetID
		}
	case command.SessionID != "":
		s.mu.Lock()
		targetID = s.sessions[command.SessionID]
		s.mu.Unlock()
	default:
		if match := pagePath.FindStringSubmatch(s.target.URL); match != nil {
			targetID = match[1]
		}
	}
	reply := func(response Reply) {
		s.mu.Lock()
		disposed := s.disposed
		s.mu.Unlock()
		if disposed {
			return
		}
		var buffer bytes.Buffer
		buffer.WriteString(`{"id":`)
		buffer.WriteString(itoa64(*command.ID))
		if command.SessionID != "" {
			sessionID, _ := json.Marshal(command.SessionID)
			buffer.WriteString(`,"sessionId":`)
			buffer.Write(sessionID)
		}
		if len(response.Error) > 0 {
			buffer.WriteString(`,"error":`)
			buffer.Write(response.Error)
		} else {
			result := response.Result
			if len(result) == 0 {
				result = json.RawMessage(`{}`)
			}
			buffer.WriteString(`,"result":`)
			buffer.Write(result)
		}
		buffer.WriteByte('}')
		_ = s.client.write(websocket.TextMessage, buffer.Bytes())
	}
	if targetID == "" {
		reply(Reply{Error: json.RawMessage(`{"code":-32000,"message":"Cannot identify the tab to close safely"}`)})
		return
	}
	key := replyKey(command.SessionID, *command.ID)
	go func() {
		response, err := s.guard.Close(s.target.ProfileID, s.target.BrowserURL, targetID, func() (Reply, error) {
			s.mu.Lock()
			if s.disposed {
				s.mu.Unlock()
				return Reply{}, errors.New("CDP connection closed")
			}
			request := &pendingReply{reply: make(chan Reply, 1)}
			s.pending[key] = request
			s.mu.Unlock()
			if err := s.upstream.write(messageType, data); err != nil {
				return Reply{}, err
			}
			select {
			case response, ok := <-request.reply:
				if !ok {
					return Reply{}, errors.New("CDP connection closed during tab protection")
				}
				return response, nil
			case <-time.After(10 * time.Second):
				s.mu.Lock()
				delete(s.pending, key)
				s.expired[key] = true
				s.mu.Unlock()
				return Reply{}, errors.New("Timed out waiting for tab close")
			}
		})
		if err != nil {
			reply(Reply{Error: json.RawMessage(`{"code":-32000,"message":"Could not protect the last tab; close was not confirmed. Refresh the tab list before retrying."}`)})
			return
		}
		reply(response)
	}()
}

func (s *relayState) receive(messageType int, data []byte) {
	s.mu.Lock()
	inspect := len(s.pending) > 0 || len(s.expired) > 0
	s.mu.Unlock()
	if messageType == websocket.TextMessage && (inspect || isTargetEvent(data)) {
		var message Message
		if json.Unmarshal(data, &message) == nil {
			s.mu.Lock()
			if message.Method == "Target.attachedToTarget" && message.Params != nil && message.Params.SessionID != "" && message.Params.TargetInfo != nil {
				s.sessions[message.Params.SessionID] = message.Params.TargetInfo.TargetID
			} else if message.Method == "Target.detachedFromTarget" && message.Params != nil && message.Params.SessionID != "" {
				delete(s.sessions, message.Params.SessionID)
			}
			if message.ID != nil {
				key := replyKey(message.SessionID, *message.ID)
				if s.expired[key] {
					delete(s.expired, key)
					s.mu.Unlock()
					return
				}
				if request := s.pending[key]; request != nil {
					delete(s.pending, key)
					s.mu.Unlock()
					request.reply <- Reply{Result: message.Result, Error: message.Error}
					return
				}
			}
			s.mu.Unlock()
		}
	}
	_ = s.client.write(messageType, data)
}
