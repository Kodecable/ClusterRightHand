package transport_test

import (
	"encoding/hex"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
	"google.golang.org/protobuf/proto"
)

// The same bytes are asserted in packages/protocol/test/envelope.test.ts.
const helloHex = "0a140a05302e302e30120b6f75747075742d66696c65"

func TestHelloMatchesTypeScript(t *testing.T) {
	env := &crhv1.Envelope{Body: &crhv1.Envelope_Hello{Hello: &crhv1.Hello{
		CrhaVersion:  "0.0.0",
		Capabilities: []string{"output-file"},
	}}}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(b); got != helloHex {
		t.Fatalf("encoding = %s, want %s", got, helloHex)
	}
}
