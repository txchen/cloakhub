package browser

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ProxySession is the proxy URL handed to the browser for one launch.
type ProxySession interface {
	BrowserURL() string
	Close()
}

// ProxyRuntime prepares a browser proxy for a profile's proxy setting.
type ProxyRuntime interface {
	Prepare(proxy string) (ProxySession, error)
}

type directProxy string

func (d directProxy) BrowserURL() string { return string(d) }
func (d directProxy) Close()             {}

type proxyRuntime struct{}

// NewProxyRuntime returns the default ProxyRuntime. Chromium cannot take proxy
// credentials on its command line, so an authenticated HTTP(S) proxy is fronted by
// a credential-free local relay that adds Proxy-Authorization.
func NewProxyRuntime() ProxyRuntime { return proxyRuntime{} }

func (proxyRuntime) Prepare(proxy string) (ProxySession, error) {
	if proxy == "" {
		return directProxy(""), nil
	}
	upstream, err := url.Parse(proxy)
	if err != nil {
		return nil, err
	}
	if upstream.User == nil || upstream.Scheme == "socks5" {
		return directProxy(proxy), nil
	}
	if upstream.Scheme != "http" && upstream.Scheme != "https" {
		return nil, errors.New("Unsupported authenticated proxy protocol: " + upstream.Scheme + ":")
	}
	return startRelay(upstream)
}

type relay struct {
	listener      net.Listener
	upstream      *url.URL
	authorization string
	transport     *http.Transport
	mu            sync.Mutex
	conns         map[net.Conn]bool
	closeOnce     sync.Once
}

func startRelay(upstream *url.URL) (*relay, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	username := upstream.User.Username()
	password, _ := upstream.User.Password()
	r := &relay{
		listener:      listener,
		upstream:      upstream,
		authorization: "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password)),
		conns:         map[net.Conn]bool{},
	}
	proxyURL := &url.URL{Scheme: upstream.Scheme, Host: upstream.Host}
	r.transport = &http.Transport{
		Proxy:              http.ProxyURL(proxyURL),
		ProxyConnectHeader: http.Header{"Proxy-Authorization": {r.authorization}},
		DisableCompression: true,
	}
	server := &http.Server{
		Handler: http.HandlerFunc(r.serve),
		ConnState: func(conn net.Conn, state http.ConnState) {
			r.mu.Lock()
			defer r.mu.Unlock()
			switch state {
			case http.StateNew:
				r.conns[conn] = true
			case http.StateClosed:
				delete(r.conns, conn)
			}
		},
	}
	go server.Serve(listener)
	return r, nil
}

func (r *relay) BrowserURL() string { return "http://" + r.listener.Addr().String() }

func (r *relay) Close() {
	r.closeOnce.Do(func() {
		r.listener.Close()
		r.mu.Lock()
		for conn := range r.conns {
			conn.Close()
		}
		r.mu.Unlock()
		r.transport.CloseIdleConnections()
	})
}

func (r *relay) track(conn net.Conn) func() {
	r.mu.Lock()
	r.conns[conn] = true
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.conns, conn)
		r.mu.Unlock()
	}
}

func (r *relay) serve(w http.ResponseWriter, req *http.Request) {
	if req.Method == http.MethodConnect {
		r.connect(w, req)
		return
	}
	// Forward absolute-URI requests to the upstream proxy with credentials.
	out := req.Clone(req.Context())
	out.RequestURI = ""
	out.Header.Set("Proxy-Authorization", r.authorization)
	response, err := r.transport.RoundTrip(out)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	for name, values := range response.Header {
		w.Header()[name] = values
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

var connectStatus = regexp.MustCompile(`^HTTP/1\.[01] 2\d\d(?: |$)`)

func (r *relay) connect(w http.ResponseWriter, req *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	untrackClient := r.track(client)
	defer untrackClient()

	address := r.upstream.Host
	dialer := &net.Dialer{Timeout: 30 * time.Second}
	var upstream net.Conn
	if r.upstream.Scheme == "https" {
		upstream, err = tls.DialWithDialer(dialer, "tcp", address, &tls.Config{ServerName: r.upstream.Hostname()})
	} else {
		upstream, err = dialer.Dial("tcp", address)
	}
	if err != nil {
		_, _ = client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	defer upstream.Close()
	untrackUpstream := r.track(upstream)
	defer untrackUpstream()

	target := req.RequestURI
	_, err = io.WriteString(upstream, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\nProxy-Authorization: "+r.authorization+"\r\nProxy-Connection: Keep-Alive\r\n\r\n")
	if err != nil {
		_, _ = client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	reader := bufio.NewReader(upstream)
	var head bytes.Buffer
	for !bytes.HasSuffix(head.Bytes(), []byte("\r\n\r\n")) {
		line, err := reader.ReadSlice('\n')
		head.Write(line)
		if err != nil || head.Len() > 64*1024 {
			_, _ = client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			return
		}
	}
	_, _ = client.Write(head.Bytes())
	statusLine, _, _ := strings.Cut(head.String(), "\r\n")
	if !connectStatus.MatchString(statusLine) {
		return
	}
	// Bytes the upstream already sent past its response head, and bytes the client
	// sent past its CONNECT request, must not be lost.
	if pending := reader.Buffered(); pending > 0 {
		chunk, _ := reader.Peek(pending)
		_, _ = client.Write(chunk)
	}
	if pending := buffered.Reader.Buffered(); pending > 0 {
		chunk, _ := buffered.Reader.Peek(pending)
		_, _ = upstream.Write(chunk)
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
}
