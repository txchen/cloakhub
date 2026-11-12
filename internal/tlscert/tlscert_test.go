package tlscert

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestGeneratesOnceAndReuses(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tls")
	first, err := Ensure("", "", dir, []string{"hub.example", "203.0.113.7"})
	if err != nil || !first.Generated {
		t.Fatalf("%+v %v", first, err)
	}
	if info, _ := os.Stat(first.Key); info.Mode().Perm() != 0o600 {
		t.Errorf("key mode %v", info.Mode().Perm())
	}
	pair, _ := tls.LoadX509KeyPair(first.Cert, first.Key)
	leaf, _ := x509.ParseCertificate(pair.Certificate[0])
	if !slices.Contains(leaf.DNSNames, "localhost") || !slices.Contains(leaf.DNSNames, "hub.example") ||
		!slices.ContainsFunc(leaf.IPAddresses, func(ip net.IP) bool { return ip.String() == "203.0.113.7" }) {
		t.Errorf("SANs %v %v", leaf.DNSNames, leaf.IPAddresses)
	}
	if time.Until(leaf.NotAfter) < 9*365*24*time.Hour {
		t.Errorf("validity %v", leaf.NotAfter)
	}
	again, err := Ensure("", "", dir, nil)
	if err != nil || again.Generated {
		t.Errorf("certificate regenerated: %+v %v", again, err)
	}
	os.Remove(first.Key)
	if regenerated, _ := Ensure("", "", dir, nil); !regenerated.Generated {
		t.Error("missing key not regenerated")
	}
}

func TestOperatorPairMustBeComplete(t *testing.T) {
	dir := t.TempDir()
	generated, _ := Ensure("", "", dir, nil)
	if files, err := Ensure(generated.Cert, generated.Key, "", nil); err != nil || files.Generated || files.Cert != generated.Cert {
		t.Errorf("operator pair %+v %v", files, err)
	}
	if _, err := Ensure(generated.Cert, "", "", nil); err == nil {
		t.Error("cert without key accepted")
	}
	if _, err := Ensure(generated.Key, generated.Key, "", nil); err == nil {
		t.Error("invalid pair accepted")
	}
}

func TestServesHTTPS(t *testing.T) {
	files, err := Ensure("", "", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil {
			t.Error("request not over TLS")
		}
		w.Write([]byte("secure"))
	})}
	go server.ServeTLS(listener, files.Cert, files.Key)
	defer server.Close()
	pool := x509.NewCertPool()
	raw, _ := os.ReadFile(files.Cert)
	pool.AppendCertsFromPEM(raw)
	client := http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "localhost"}}}
	response, err := client.Get("https://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "secure" {
		t.Errorf("body %q", body)
	}
}
