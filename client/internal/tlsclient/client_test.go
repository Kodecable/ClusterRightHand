package tlsclient

import (
	"net/http"
	"testing"
)

// TestInsecure covers the one insecure client builder: it skips certificate verification, follows
// the proxy environment and bounds a request.
func TestInsecure(t *testing.T) {
	client := Insecure()
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport = %T, want *http.Transport", client.Transport)
	}
	if transport.Proxy == nil {
		t.Fatal("the insecure client does not use the proxy environment")
	}
	if transport.TLSClientConfig == nil || !transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatalf("TLS config = %+v, want verification off", transport.TLSClientConfig)
	}
	if client.Timeout != Timeout {
		t.Fatalf("timeout = %v, want %v", client.Timeout, Timeout)
	}
	if transport.TLSClientConfig.MinVersion != 0 || transport.TLSClientConfig.ServerName != "" {
		t.Fatalf("TLS config carries settings of its own: %+v", transport.TLSClientConfig)
	}
}
