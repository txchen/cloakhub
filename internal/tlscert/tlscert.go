// Package tlscert provides the certificate for CloakHub's built-in HTTPS listener:
// an operator-supplied pair, or a self-signed one generated once under the Data Root.
package tlscert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Validity of a generated certificate. Browsers ask once per certificate, so it
// lives long; it is regenerated when it expires or its files go missing.
const validity = 10 * 365 * 24 * time.Hour

// Files are the PEM certificate chain and private key paths.
type Files struct {
	Cert, Key string
	// Generated reports whether the pair was created by this call.
	Generated bool
}

// Ensure returns cert and key, or a self-signed pair under dir, generating it when
// absent or expired. hosts become subject alternative names besides localhost.
func Ensure(cert, key, dir string, hosts []string) (Files, error) {
	if cert != "" || key != "" {
		if cert == "" || key == "" {
			return Files{}, errors.New("CLOAKHUB_TLS_CERT and CLOAKHUB_TLS_KEY must be set together")
		}
		if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
			return Files{}, fmt.Errorf("cannot load CLOAKHUB_TLS_CERT/CLOAKHUB_TLS_KEY: %w", err)
		}
		return Files{Cert: cert, Key: key}, nil
	}
	files := Files{Cert: filepath.Join(dir, "cert.pem"), Key: filepath.Join(dir, "key.pem")}
	if usable(files) {
		return files, nil
	}
	if err := generate(files, hosts); err != nil {
		return Files{}, err
	}
	files.Generated = true
	return files, nil
}

func usable(files Files) bool {
	pair, err := tls.LoadX509KeyPair(files.Cert, files.Key)
	if err != nil || len(pair.Certificate) == 0 {
		return false
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	return err == nil && time.Now().Add(24*time.Hour).Before(leaf.NotAfter)
}

func generate(files Files, hosts []string) error {
	if err := os.MkdirAll(filepath.Dir(files.Cert), 0o700); err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return err
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "CloakHub self-signed", Organization: []string{"CloakHub"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	for _, host := range names(hosts) {
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, host)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err := writePEM(files.Key, "PRIVATE KEY", keyDER, 0o600); err != nil {
		return err
	}
	return writePEM(files.Cert, "CERTIFICATE", der, 0o644)
}

// names lists localhost, the machine's host name and addresses, and extra hosts.
func names(extra []string) []string {
	result := []string{"localhost", "127.0.0.1", "::1"}
	if hostname, err := os.Hostname(); err == nil && hostname != "" {
		result = append(result, hostname)
	}
	if addresses, err := net.InterfaceAddrs(); err == nil {
		for _, address := range addresses {
			if network, ok := address.(*net.IPNet); ok && !network.IP.IsLoopback() && !network.IP.IsLinkLocalUnicast() {
				result = append(result, network.IP.String())
			}
		}
	}
	for _, host := range extra {
		if host != "" && !slices.Contains(result, host) {
			result = append(result, host)
		}
	}
	return result
}

func writePEM(path, kind string, der []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), mode); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
