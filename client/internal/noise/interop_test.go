package noise

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// TestInteropFixture checks this implementation against the transcript produced by the TypeScript
// implementation in packages/noise (test/interop/noise-crh.json).
func TestInteropFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../test/interop/noise-crh.json")
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]string
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	b := func(k string) []byte {
		v, err := hex.DecodeString(f[k])
		if err != nil {
			t.Fatalf("%s: %v", k, err)
		}
		return v
	}
	key := func(k string) Keypair {
		kp, err := KeypairFromPrivate(b(k))
		if err != nil {
			t.Fatal(err)
		}
		return kp
	}
	clientEph, serverEph := key("client_ephemeral"), key("server_ephemeral")
	server := key("server_static")

	ini, err := newInitiator(key("client_static"), server.Public, b("challenge"), &clientEph)
	if err != nil {
		t.Fatal(err)
	}
	m1, err := ini.WriteInit(b("init_payload"))
	if err != nil || !bytes.Equal(m1, b("message1")) {
		t.Fatalf("message1 = %x, %v", m1, err)
	}
	res, _ := newResponder(server, b("challenge"), &serverEph)
	if p, _, err := res.ReadInit(m1); err != nil || !bytes.Equal(p, b("init_payload")) {
		t.Fatalf("ReadInit = %q, %v", p, err)
	}
	m2, rs, err := res.WriteResponse(b("response_payload"))
	if err != nil || !bytes.Equal(m2, b("message2")) {
		t.Fatalf("message2 = %x, %v", m2, err)
	}
	p, cs, err := ini.ReadResponse(m2)
	if err != nil || !bytes.Equal(p, b("response_payload")) {
		t.Fatalf("ReadResponse = %q, %v", p, err)
	}
	if !bytes.Equal(cs.HandshakeHash, b("handshake_hash")) {
		t.Fatalf("handshake hash = %x", cs.HandshakeHash)
	}
	if ct, _ := cs.Encrypt(b("client_to_server")); !bytes.Equal(ct, b("transport_c2s")) {
		t.Fatalf("c2s = %x", ct)
	}
	if ct, _ := rs.Encrypt(b("server_to_client")); !bytes.Equal(ct, b("transport_s2c")) {
		t.Fatalf("s2c = %x", ct)
	}
}
