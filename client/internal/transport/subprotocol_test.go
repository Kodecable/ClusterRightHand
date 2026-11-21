package transport

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// A crhs that does not serve crha's major answers 426 before any handshake; crha names its major in
// the request and reports the refusal as a handshake error (doc/design/protocol.md "The major in the clear").
func TestDialNamesTheMajorAndReportsA426(t *testing.T) {
	var got []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("Sec-WebSocket-Protocol"))
		w.Header().Set(ServedMajorsHeader, "4,5")
		w.WriteHeader(http.StatusUpgradeRequired)
		_, _ = w.Write([]byte("crhs serves protocol majors 4, 5;\nthis crha speaks major 3.\n"))
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")

	for _, dial := range []func() error{
		func() error { _, err := Dial(context.Background(), DialOptions{URL: url + "/agent"}); return err },
		func() error {
			_, err := DialData(context.Background(), DataDialOptions{URL: url + "/agent/data"})
			return err
		},
	} {
		err := dial()
		var he *HandshakeError
		if !errors.As(err, &he) {
			t.Fatalf("error = %v, want a HandshakeError", err)
		}
		for _, want := range []string{
			fmt.Sprintf("does not serve protocol major %d", protocol.ProtocolMajor), "it serves 4,5", "this crha speaks major 3.",
		} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q does not contain %q", err, want)
			}
		}
	}
	want := fmt.Sprintf("crh.%d", protocol.ProtocolMajor)
	if len(got) != 2 || got[0] != want || got[1] != want {
		t.Fatalf("subprotocols sent = %q, want %q twice", got, want)
	}
	if Subprotocol() != want {
		t.Fatalf("Subprotocol() = %q, want %q", Subprotocol(), want)
	}
}
