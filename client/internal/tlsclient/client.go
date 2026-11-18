// Package tlsclient builds the HTTP clients used where crhs is authenticated by a pinned key
// fingerprint instead of by its TLS certificate.
package tlsclient

import (
	"crypto/tls"
	"net/http"
	"time"
)

// Timeout bounds one request made with an insecure client: the TLS handshake, the request and the
// response headers. The transports raise their own dial timeouts.
const Timeout = 20 * time.Second

// Insecure returns a client that skips certificate verification and honors the proxy environment.
// The TLS certificate proves nothing about the server, so the caller must check the pinned key.
func Insecure() *http.Client {
	return &http.Client{
		Timeout: Timeout,
		Transport: &http.Transport{
			Proxy:           http.ProxyFromEnvironment,
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // the caller pins the server key
		},
	}
}
